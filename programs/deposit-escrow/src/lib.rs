use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer as SplTransfer};

declare_id!("Em436QuUeGG4g6ErrABWnbjjDBEPLnzoPVDXmQ6o2hYm");

const CLAIM_RESPONSE_WINDOW: i64 = 5 * 24 * 60 * 60; // 5 days for tenant to respond
const RELEASE_GRACE_PERIOD: i64 = 3 * 24 * 60 * 60; // 3 days after lease end before auto-release

#[program]
pub mod deposit_escrow {
    use super::*;

    /// Tenant creates the escrow and deposits SOL into the vault PDA.
    pub fn initialize(ctx: Context<Initialize>, amount: u64, lease_end: i64) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(
            lease_end > Clock::get()?.unix_timestamp,
            EscrowError::InvalidLeaseEnd
        );

        let escrow = &mut ctx.accounts.escrow;
        escrow.landlord = ctx.accounts.landlord.key();
        escrow.tenant = ctx.accounts.tenant.key();
        escrow.amount = amount;
        escrow.lease_end = lease_end;
        escrow.state = EscrowState::Active;
        escrow.claim_amount = 0;
        escrow.claim_deadline = 0;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        // Move the deposit from tenant into the vault PDA (tenant signs normally).
        let cpi = CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.tenant.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi, amount)?;

        emit!(EscrowInitialized {
            escrow: escrow.key(),
            landlord: escrow.landlord,
            tenant: escrow.tenant,
            amount,
            lease_end,
        });
        Ok(())
    }

    /// Landlord files a damage claim once the lease has ended.
    pub fn file_claim(ctx: Context<FileClaim>, claim_amount: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(
            clock.unix_timestamp >= escrow.lease_end,
            EscrowError::LeaseNotEnded
        );
        require!(escrow.state == EscrowState::Active, EscrowError::InvalidState);
        require!(claim_amount > 0, EscrowError::InvalidAmount);
        require!(
            claim_amount <= escrow.amount,
            EscrowError::ClaimExceedsDeposit
        );

        escrow.state = EscrowState::ClaimFiled;
        escrow.claim_amount = claim_amount;
        escrow.claim_deadline = clock.unix_timestamp + CLAIM_RESPONSE_WINDOW;

        emit!(ClaimFiled {
            escrow: escrow.key(),
            claim_amount,
            deadline: escrow.claim_deadline,
        });
        Ok(())
    }

    /// Tenant accepts the claim: vault pays landlord the claim and refunds the rest.
    pub fn accept_claim(ctx: Context<AcceptClaim>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.state == EscrowState::ClaimFiled,
            EscrowError::InvalidState
        );

        let escrow_key = escrow.key();
        let claim_amount = escrow.claim_amount;
        let refund_amount = escrow
            .amount
            .checked_sub(claim_amount)
            .ok_or(EscrowError::MathOverflow)?;
        let vault_bump = escrow.vault_bump;

        vault_pay(
            &ctx.accounts.system_program,
            &ctx.accounts.vault,
            &ctx.accounts.landlord.to_account_info(),
            &escrow_key,
            vault_bump,
            claim_amount,
        )?;
        vault_pay(
            &ctx.accounts.system_program,
            &ctx.accounts.vault,
            &ctx.accounts.tenant.to_account_info(),
            &escrow_key,
            vault_bump,
            refund_amount,
        )?;

        ctx.accounts.escrow.state = EscrowState::Settled;
        emit!(ClaimResolved {
            escrow: escrow_key,
            to_landlord: claim_amount,
            to_tenant: refund_amount,
            by_timeout: false,
        });
        Ok(())
    }

    /// Tenant disputes the claim within the window: freeze for off-chain arbitration.
    pub fn dispute_claim(ctx: Context<DisputeClaim>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.state == EscrowState::ClaimFiled,
            EscrowError::InvalidState
        );
        require!(
            Clock::get()?.unix_timestamp <= escrow.claim_deadline,
            EscrowError::ClaimExpired
        );
        escrow.state = EscrowState::Disputed;

        emit!(ClaimDisputed {
            escrow: escrow.key(),
        });
        Ok(())
    }

    /// Permissionless: after the response window lapses, settle in landlord's favor.
    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.state == EscrowState::ClaimFiled,
            EscrowError::InvalidState
        );
        require!(
            Clock::get()?.unix_timestamp > escrow.claim_deadline,
            EscrowError::ClaimNotExpired
        );

        let escrow_key = escrow.key();
        let claim_amount = escrow.claim_amount;
        let refund_amount = escrow
            .amount
            .checked_sub(claim_amount)
            .ok_or(EscrowError::MathOverflow)?;
        let vault_bump = escrow.vault_bump;

        vault_pay(
            &ctx.accounts.system_program,
            &ctx.accounts.vault,
            &ctx.accounts.landlord.to_account_info(),
            &escrow_key,
            vault_bump,
            claim_amount,
        )?;
        vault_pay(
            &ctx.accounts.system_program,
            &ctx.accounts.vault,
            &ctx.accounts.tenant.to_account_info(),
            &escrow_key,
            vault_bump,
            refund_amount,
        )?;

        ctx.accounts.escrow.state = EscrowState::Settled;
        emit!(ClaimResolved {
            escrow: escrow_key,
            to_landlord: claim_amount,
            to_tenant: refund_amount,
            by_timeout: true,
        });
        Ok(())
    }

    /// Permissionless: if no claim was filed within the grace period, refund the tenant.
    pub fn release(ctx: Context<Release>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Active, EscrowError::InvalidState);
        require!(
            Clock::get()?.unix_timestamp >= escrow.lease_end + RELEASE_GRACE_PERIOD,
            EscrowError::TooEarlyToRelease
        );

        let escrow_key = escrow.key();
        let amount = escrow.amount;
        let vault_bump = escrow.vault_bump;

        vault_pay(
            &ctx.accounts.system_program,
            &ctx.accounts.vault,
            &ctx.accounts.tenant.to_account_info(),
            &escrow_key,
            vault_bump,
            amount,
        )?;

        ctx.accounts.escrow.state = EscrowState::Released;
        emit!(DepositReleased {
            escrow: escrow_key,
            amount,
        });
        Ok(())
    }

    /// Permissionless cleanup: once the escrow reaches a terminal state and the vault
    /// is empty, close the data account and return its rent to the tenant who paid it.
    pub fn close_escrow(ctx: Context<CloseEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            matches!(escrow.state, EscrowState::Settled | EscrowState::Released),
            EscrowError::NotClosable
        );

        emit!(EscrowClosed {
            escrow: escrow.key(),
        });
        Ok(())
    }

    // ============================================================
    // SPL-token variant (e.g. USDC). A rental deposit is denominated
    // in fiat, so locking it in a stablecoin removes the price risk
    // of holding native SOL. Same state machine, token vault instead
    // of a lamport vault. Fully isolated from the SOL flow above.
    // ============================================================

    /// Tenant creates a token escrow and deposits SPL tokens into the vault.
    pub fn initialize_token(
        ctx: Context<InitializeToken>,
        amount: u64,
        lease_end: i64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(
            lease_end > Clock::get()?.unix_timestamp,
            EscrowError::InvalidLeaseEnd
        );

        let escrow = &mut ctx.accounts.escrow;
        escrow.landlord = ctx.accounts.landlord.key();
        escrow.tenant = ctx.accounts.tenant.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.amount = amount;
        escrow.lease_end = lease_end;
        escrow.state = EscrowState::Active;
        escrow.claim_amount = 0;
        escrow.claim_deadline = 0;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        let cpi = CpiContext::new(
            ctx.accounts.token_program.key(),
            SplTransfer {
                from: ctx.accounts.tenant_ata.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.tenant.to_account_info(),
            },
        );
        token::transfer(cpi, amount)?;

        emit!(EscrowInitialized {
            escrow: escrow.key(),
            landlord: escrow.landlord,
            tenant: escrow.tenant,
            amount,
            lease_end,
        });
        Ok(())
    }

    /// Landlord files a damage claim on a token escrow once the lease has ended.
    pub fn file_claim_token(ctx: Context<FileClaimToken>, claim_amount: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= escrow.lease_end,
            EscrowError::LeaseNotEnded
        );
        require!(escrow.state == EscrowState::Active, EscrowError::InvalidState);
        require!(claim_amount > 0, EscrowError::InvalidAmount);
        require!(
            claim_amount <= escrow.amount,
            EscrowError::ClaimExceedsDeposit
        );

        escrow.state = EscrowState::ClaimFiled;
        escrow.claim_amount = claim_amount;
        escrow.claim_deadline = clock.unix_timestamp + CLAIM_RESPONSE_WINDOW;

        emit!(ClaimFiled {
            escrow: escrow.key(),
            claim_amount,
            deadline: escrow.claim_deadline,
        });
        Ok(())
    }

    /// Tenant accepts the claim: vault pays landlord the claim, refunds the rest.
    pub fn accept_claim_token(ctx: Context<AcceptClaimToken>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.state == EscrowState::ClaimFiled,
            EscrowError::InvalidState
        );
        let (landlord, tenant, mint, bump) =
            (escrow.landlord, escrow.tenant, escrow.mint, escrow.bump);
        let escrow_key = escrow.key();
        let claim = escrow.claim_amount;
        let refund = escrow
            .amount
            .checked_sub(claim)
            .ok_or(EscrowError::MathOverflow)?;

        let seeds: &[&[u8]] = &[
            b"tescrow",
            landlord.as_ref(),
            tenant.as_ref(),
            mint.as_ref(),
            &[bump],
        ];
        let signer: &[&[&[u8]]] = &[seeds];
        token_pay(
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.landlord_ata.to_account_info(),
            ctx.accounts.escrow.to_account_info(),
            signer,
            claim,
        )?;
        token_pay(
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.tenant_ata.to_account_info(),
            ctx.accounts.escrow.to_account_info(),
            signer,
            refund,
        )?;

        ctx.accounts.escrow.state = EscrowState::Settled;
        emit!(ClaimResolved {
            escrow: escrow_key,
            to_landlord: claim,
            to_tenant: refund,
            by_timeout: false,
        });
        Ok(())
    }

    /// Tenant disputes the token claim within the window: freeze for arbitration.
    pub fn dispute_claim_token(ctx: Context<DisputeClaimToken>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.state == EscrowState::ClaimFiled,
            EscrowError::InvalidState
        );
        require!(
            Clock::get()?.unix_timestamp <= escrow.claim_deadline,
            EscrowError::ClaimExpired
        );
        escrow.state = EscrowState::Disputed;
        emit!(ClaimDisputed {
            escrow: escrow.key(),
        });
        Ok(())
    }

    /// Permissionless: after the response window lapses, settle for the landlord.
    pub fn claim_timeout_token(ctx: Context<ClaimTimeoutToken>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.state == EscrowState::ClaimFiled,
            EscrowError::InvalidState
        );
        require!(
            Clock::get()?.unix_timestamp > escrow.claim_deadline,
            EscrowError::ClaimNotExpired
        );
        let (landlord, tenant, mint, bump) =
            (escrow.landlord, escrow.tenant, escrow.mint, escrow.bump);
        let escrow_key = escrow.key();
        let claim = escrow.claim_amount;
        let refund = escrow
            .amount
            .checked_sub(claim)
            .ok_or(EscrowError::MathOverflow)?;

        let seeds: &[&[u8]] = &[
            b"tescrow",
            landlord.as_ref(),
            tenant.as_ref(),
            mint.as_ref(),
            &[bump],
        ];
        let signer: &[&[&[u8]]] = &[seeds];
        token_pay(
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.landlord_ata.to_account_info(),
            ctx.accounts.escrow.to_account_info(),
            signer,
            claim,
        )?;
        token_pay(
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.tenant_ata.to_account_info(),
            ctx.accounts.escrow.to_account_info(),
            signer,
            refund,
        )?;

        ctx.accounts.escrow.state = EscrowState::Settled;
        emit!(ClaimResolved {
            escrow: escrow_key,
            to_landlord: claim,
            to_tenant: refund,
            by_timeout: true,
        });
        Ok(())
    }

    /// Permissionless: if no claim within the grace period, refund the tenant.
    pub fn release_token(ctx: Context<ReleaseToken>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Active, EscrowError::InvalidState);
        require!(
            Clock::get()?.unix_timestamp >= escrow.lease_end + RELEASE_GRACE_PERIOD,
            EscrowError::TooEarlyToRelease
        );
        let (landlord, tenant, mint, bump) =
            (escrow.landlord, escrow.tenant, escrow.mint, escrow.bump);
        let escrow_key = escrow.key();
        let amount = escrow.amount;

        let seeds: &[&[u8]] = &[
            b"tescrow",
            landlord.as_ref(),
            tenant.as_ref(),
            mint.as_ref(),
            &[bump],
        ];
        let signer: &[&[&[u8]]] = &[seeds];
        token_pay(
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.tenant_ata.to_account_info(),
            ctx.accounts.escrow.to_account_info(),
            signer,
            amount,
        )?;

        ctx.accounts.escrow.state = EscrowState::Released;
        emit!(DepositReleased {
            escrow: escrow_key,
            amount,
        });
        Ok(())
    }

    /// Permissionless cleanup: from a terminal state, close the (empty) token vault
    /// and the data account, returning both rents to the tenant.
    pub fn close_token(ctx: Context<CloseToken>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            matches!(escrow.state, EscrowState::Settled | EscrowState::Released),
            EscrowError::NotClosable
        );
        let (landlord, tenant, mint, bump) =
            (escrow.landlord, escrow.tenant, escrow.mint, escrow.bump);
        let escrow_key = escrow.key();

        let seeds: &[&[u8]] = &[
            b"tescrow",
            landlord.as_ref(),
            tenant.as_ref(),
            mint.as_ref(),
            &[bump],
        ];
        let signer: &[&[&[u8]]] = &[seeds];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.tenant.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer,
        );
        token::close_account(cpi)?;

        emit!(EscrowClosed { escrow: escrow_key });
        Ok(())
    }
}

/// Moves lamports OUT of the vault PDA via a system transfer signed by the vault seeds.
fn vault_pay<'info>(
    system_program: &Program<'info, System>,
    vault: &SystemAccount<'info>,
    to: &AccountInfo<'info>,
    escrow_key: &Pubkey,
    vault_bump: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[b"vault", escrow_key.as_ref(), &[vault_bump]];
    let signer: &[&[&[u8]]] = &[seeds];
    let cpi = CpiContext::new_with_signer(
        system_program.key(),
        Transfer {
            from: vault.to_account_info(),
            to: to.clone(),
        },
        signer,
    );
    system_program::transfer(cpi, amount)
}

/// Moves SPL tokens OUT of the token vault, signed by the escrow PDA authority.
fn token_pay<'info>(
    token_program: Pubkey,
    vault: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let cpi = CpiContext::new_with_signer(
        token_program,
        SplTransfer {
            from: vault,
            to,
            authority,
        },
        signer_seeds,
    );
    token::transfer(cpi, amount)
}

// ---- Account data ----

#[account]
#[derive(InitSpace)]
pub struct DepositEscrow {
    pub landlord: Pubkey,
    pub tenant: Pubkey,
    pub amount: u64,
    pub lease_end: i64,
    pub state: EscrowState,
    pub claim_amount: u64,
    pub claim_deadline: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, InitSpace)]
pub enum EscrowState {
    Active,
    ClaimFiled,
    Released,
    Settled,
    Disputed,
}

// ---- Events ----

#[event]
pub struct EscrowInitialized {
    pub escrow: Pubkey,
    pub landlord: Pubkey,
    pub tenant: Pubkey,
    pub amount: u64,
    pub lease_end: i64,
}

#[event]
pub struct ClaimFiled {
    pub escrow: Pubkey,
    pub claim_amount: u64,
    pub deadline: i64,
}

#[event]
pub struct ClaimResolved {
    pub escrow: Pubkey,
    pub to_landlord: u64,
    pub to_tenant: u64,
    /// false = tenant accepted; true = settled by timeout crank.
    pub by_timeout: bool,
}

#[event]
pub struct ClaimDisputed {
    pub escrow: Pubkey,
}

#[event]
pub struct DepositReleased {
    pub escrow: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EscrowClosed {
    pub escrow: Pubkey,
}

// ---- Contexts ----

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub tenant: Signer<'info>,
    /// CHECK: landlord is a recipient pubkey, bound by escrow seeds.
    pub landlord: AccountInfo<'info>,
    #[account(
        init,
        payer = tenant,
        space = 8 + DepositEscrow::INIT_SPACE,
        seeds = [b"escrow", landlord.key().as_ref(), tenant.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, DepositEscrow>,
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FileClaim<'info> {
    #[account(mut)]
    pub landlord: Signer<'info>,
    /// CHECK: tenant pubkey bound by escrow seeds.
    pub tenant: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"escrow", landlord.key().as_ref(), tenant.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
    )]
    pub escrow: Account<'info, DepositEscrow>,
}

#[derive(Accounts)]
pub struct AcceptClaim<'info> {
    #[account(mut)]
    pub tenant: Signer<'info>,
    /// CHECK: landlord receives lamports; bound by escrow seeds.
    #[account(mut)]
    pub landlord: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"escrow", landlord.key().as_ref(), tenant.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
    )]
    pub escrow: Account<'info, DepositEscrow>,
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DisputeClaim<'info> {
    #[account(mut)]
    pub tenant: Signer<'info>,
    /// CHECK: landlord pubkey bound by escrow seeds.
    pub landlord: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"escrow", landlord.key().as_ref(), tenant.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
    )]
    pub escrow: Account<'info, DepositEscrow>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    /// CHECK: landlord receives lamports; bound by escrow seeds.
    #[account(mut)]
    pub landlord: AccountInfo<'info>,
    /// CHECK: tenant receives the remainder; bound by escrow seeds.
    #[account(mut)]
    pub tenant: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"escrow", landlord.key().as_ref(), tenant.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
    )]
    pub escrow: Account<'info, DepositEscrow>,
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    /// CHECK: tenant receives lamports; bound by escrow seeds.
    #[account(mut)]
    pub tenant: AccountInfo<'info>,
    /// CHECK: landlord pubkey bound by escrow seeds.
    pub landlord: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"escrow", landlord.key().as_ref(), tenant.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
    )]
    pub escrow: Account<'info, DepositEscrow>,
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseEscrow<'info> {
    /// CHECK: tenant receives the reclaimed rent; bound by escrow seeds.
    #[account(mut)]
    pub tenant: AccountInfo<'info>,
    /// CHECK: landlord pubkey bound by escrow seeds.
    pub landlord: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"escrow", landlord.key().as_ref(), tenant.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
        close = tenant,
    )]
    pub escrow: Account<'info, DepositEscrow>,
}

// ---- Token escrow: data + contexts ----

#[account]
#[derive(InitSpace)]
pub struct TokenEscrow {
    pub landlord: Pubkey,
    pub tenant: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub lease_end: i64,
    pub state: EscrowState,
    pub claim_amount: u64,
    pub claim_deadline: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(Accounts)]
pub struct InitializeToken<'info> {
    #[account(mut)]
    pub tenant: Signer<'info>,
    /// CHECK: landlord recipient pubkey, bound by escrow seeds.
    pub landlord: AccountInfo<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = tenant,
        space = 8 + TokenEscrow::INIT_SPACE,
        seeds = [b"tescrow", landlord.key().as_ref(), tenant.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, TokenEscrow>,
    #[account(
        init,
        payer = tenant,
        seeds = [b"tvault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = tenant)]
    pub tenant_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FileClaimToken<'info> {
    #[account(mut)]
    pub landlord: Signer<'info>,
    /// CHECK: tenant pubkey bound by escrow seeds.
    pub tenant: AccountInfo<'info>,
    /// CHECK: mint pubkey bound by escrow seeds.
    pub mint: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"tescrow", landlord.key().as_ref(), tenant.key().as_ref(), mint.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
        has_one = mint,
    )]
    pub escrow: Account<'info, TokenEscrow>,
}

#[derive(Accounts)]
pub struct AcceptClaimToken<'info> {
    #[account(mut)]
    pub tenant: Signer<'info>,
    /// CHECK: landlord pubkey bound by escrow seeds.
    pub landlord: AccountInfo<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"tescrow", landlord.key().as_ref(), tenant.key().as_ref(), mint.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
        has_one = mint,
    )]
    pub escrow: Account<'info, TokenEscrow>,
    #[account(mut, seeds = [b"tvault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = landlord)]
    pub landlord_ata: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = tenant)]
    pub tenant_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DisputeClaimToken<'info> {
    #[account(mut)]
    pub tenant: Signer<'info>,
    /// CHECK: landlord pubkey bound by escrow seeds.
    pub landlord: AccountInfo<'info>,
    /// CHECK: mint pubkey bound by escrow seeds.
    pub mint: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"tescrow", landlord.key().as_ref(), tenant.key().as_ref(), mint.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
        has_one = mint,
    )]
    pub escrow: Account<'info, TokenEscrow>,
}

#[derive(Accounts)]
pub struct ClaimTimeoutToken<'info> {
    /// CHECK: landlord pubkey bound by escrow seeds.
    pub landlord: AccountInfo<'info>,
    /// CHECK: tenant pubkey bound by escrow seeds.
    pub tenant: AccountInfo<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"tescrow", landlord.key().as_ref(), tenant.key().as_ref(), mint.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
        has_one = mint,
    )]
    pub escrow: Account<'info, TokenEscrow>,
    #[account(mut, seeds = [b"tvault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = landlord)]
    pub landlord_ata: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = tenant)]
    pub tenant_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReleaseToken<'info> {
    /// CHECK: landlord pubkey bound by escrow seeds.
    pub landlord: AccountInfo<'info>,
    /// CHECK: tenant pubkey bound by escrow seeds.
    pub tenant: AccountInfo<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"tescrow", landlord.key().as_ref(), tenant.key().as_ref(), mint.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
        has_one = mint,
    )]
    pub escrow: Account<'info, TokenEscrow>,
    #[account(mut, seeds = [b"tvault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = tenant)]
    pub tenant_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseToken<'info> {
    /// CHECK: receives reclaimed rent and is the vault-close destination.
    #[account(mut)]
    pub tenant: AccountInfo<'info>,
    /// CHECK: landlord pubkey bound by escrow seeds.
    pub landlord: AccountInfo<'info>,
    /// CHECK: mint pubkey bound by escrow seeds.
    pub mint: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"tescrow", landlord.key().as_ref(), tenant.key().as_ref(), mint.key().as_ref()],
        bump = escrow.bump,
        has_one = landlord,
        has_one = tenant,
        has_one = mint,
        close = tenant,
    )]
    pub escrow: Account<'info, TokenEscrow>,
    #[account(mut, seeds = [b"tvault", escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---- Errors ----

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Lease end date must be in the future")]
    InvalidLeaseEnd,
    #[msg("Lease has not ended yet")]
    LeaseNotEnded,
    #[msg("Invalid escrow state for this action")]
    InvalidState,
    #[msg("Claim amount exceeds deposit")]
    ClaimExceedsDeposit,
    #[msg("Claim response deadline has passed")]
    ClaimExpired,
    #[msg("Claim deadline has not passed yet")]
    ClaimNotExpired,
    #[msg("Too early to release — wait for the grace period after lease end")]
    TooEarlyToRelease,
    #[msg("Escrow can only be closed from a terminal state (Settled or Released)")]
    NotClosable,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}

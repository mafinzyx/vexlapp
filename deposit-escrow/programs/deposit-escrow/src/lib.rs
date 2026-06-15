use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

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

        msg!(
            "Escrow initialized: {} lamports, lease_end {}",
            amount,
            lease_end
        );
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

        msg!(
            "Claim filed: {} lamports; respond by {}",
            claim_amount,
            escrow.claim_deadline
        );
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
        let refund_amount = escrow.amount.checked_sub(claim_amount).unwrap();
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
        msg!(
            "Claim accepted: landlord {} / tenant refund {}",
            claim_amount,
            refund_amount
        );
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
        msg!("Claim disputed: vault frozen pending off-chain arbitration");
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
        let refund_amount = escrow.amount.checked_sub(claim_amount).unwrap();
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
        msg!("Claim timed out: landlord received {}", claim_amount);
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
        msg!("Deposit released to tenant: {}", amount);
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

// ---- Account data ----

#[account]
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

impl DepositEscrow {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1 + 8 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum EscrowState {
    Active,
    ClaimFiled,
    Released,
    Settled,
    Disputed,
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
        space = DepositEscrow::LEN,
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
}

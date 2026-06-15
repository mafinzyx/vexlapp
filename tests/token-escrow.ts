import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock } from "solana-bankrun";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMint2Instruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  AccountLayout,
} from "@solana/spl-token";
import { assert } from "chai";
import IDL from "../target/idl/deposit_escrow.json";

const PROGRAM_ID = new PublicKey(IDL.address);
const DAY = 24 * 60 * 60;
const MINT_RENT = 1_461_600; // rent-exempt lamports for an 82-byte mint
const UNIT = 1_000_000; // 6-decimal token (USDC-like): 1 token = 1e6

async function processTx(
  context: any,
  feePayer: Keypair,
  ixs: anchor.web3.TransactionInstruction[],
  signers: Keypair[]
) {
  const tx = new Transaction();
  tx.recentBlockhash = context.lastBlockhash;
  tx.feePayer = feePayer.publicKey;
  tx.add(...ixs);
  tx.sign(feePayer, ...signers);
  await context.banksClient.processTransaction(tx);
}

async function tokenBalance(context: any, ata: PublicKey): Promise<number> {
  const acct = await context.banksClient.getAccount(ata);
  if (!acct) return 0;
  return Number(AccountLayout.decode(acct.data).amount);
}

async function setup() {
  const context = await startAnchor(
    "",
    [{ name: "deposit_escrow", programId: PROGRAM_ID }],
    []
  );
  const provider = new BankrunProvider(context);
  anchor.setProvider(provider);
  const program = new Program(IDL as anchor.Idl, provider);

  const tenant = provider.wallet.payer;
  const landlord = Keypair.generate();
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;

  // Create + initialize the mint (USDC-like, 6 decimals).
  await processTx(
    context,
    tenant,
    [
      SystemProgram.createAccount({
        fromPubkey: tenant.publicKey,
        newAccountPubkey: mint,
        space: MINT_SIZE,
        lamports: MINT_RENT,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint, 6, tenant.publicKey, null),
    ],
    [mintKp]
  );

  // Tenant + landlord ATAs; mint 100 tokens to the tenant.
  const tenantAta = getAssociatedTokenAddressSync(mint, tenant.publicKey);
  const landlordAta = getAssociatedTokenAddressSync(mint, landlord.publicKey);
  await processTx(
    context,
    tenant,
    [
      createAssociatedTokenAccountInstruction(tenant.publicKey, tenantAta, tenant.publicKey, mint),
      createAssociatedTokenAccountInstruction(tenant.publicKey, landlordAta, landlord.publicKey, mint),
      createMintToInstruction(mint, tenantAta, tenant.publicKey, 100 * UNIT),
    ],
    []
  );

  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("tescrow"), landlord.publicKey.toBuffer(), tenant.publicKey.toBuffer(), mint.toBuffer()],
    PROGRAM_ID
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("tvault"), escrow.toBuffer()],
    PROGRAM_ID
  );

  return { context, program, tenant, landlord, mint, tenantAta, landlordAta, escrow, vault };
}

async function warpToUnix(context: any, unixSeconds: number) {
  const clock: Clock = await context.banksClient.getClock();
  context.setClock(
    new Clock(clock.slot, clock.epochStartTimestamp, clock.epoch, clock.leaderScheduleEpoch, BigInt(unixSeconds))
  );
}

async function nowUnix(context: any): Promise<number> {
  return Number((await context.banksClient.getClock()).unixTimestamp);
}

describe("token-escrow (USDC-like)", () => {
  it("initialize_token: locks the deposit in the token vault", async () => {
    const { context, program, tenant, landlord, mint, tenantAta, escrow, vault } = await setup();
    const amount = new anchor.BN(50 * UNIT);
    const leaseEnd = new anchor.BN((await nowUnix(context)) + 30 * DAY);

    await program.methods
      .initializeToken(amount, leaseEnd)
      .accounts({
        tenant: tenant.publicKey,
        landlord: landlord.publicKey,
        mint,
        escrow,
        vault,
        tenantAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    assert.equal(await tokenBalance(context, vault), 50 * UNIT, "vault holds deposit");
    assert.equal(await tokenBalance(context, tenantAta), 50 * UNIT, "tenant keeps the rest");
    const acct = await (program.account as any).tokenEscrow.fetch(escrow);
    assert.equal(acct.mint.toBase58(), mint.toBase58());
    assert.deepEqual(acct.state, { active: {} });
  });

  it("accept_claim_token: splits the token deposit and empties the vault", async () => {
    const { context, program, tenant, landlord, mint, tenantAta, landlordAta, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initializeToken(new anchor.BN(50 * UNIT), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, mint, escrow, vault, tenantAta, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc();

    await warpToUnix(context, leaseEnd + DAY);
    await program.methods
      .fileClaimToken(new anchor.BN(20 * UNIT))
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, mint, escrow })
      .signers([landlord])
      .rpc();

    await program.methods
      .acceptClaimToken()
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, mint, escrow, vault, landlordAta, tenantAta, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();

    assert.equal(await tokenBalance(context, landlordAta), 20 * UNIT, "landlord got the claim");
    assert.equal(await tokenBalance(context, tenantAta), 80 * UNIT, "tenant got the rest back (50 kept + 30 refund)");
    assert.equal(await tokenBalance(context, vault), 0, "vault drained");
    const acct = await (program.account as any).tokenEscrow.fetch(escrow);
    assert.deepEqual(acct.state, { settled: {} });
  });

  it("release_token: refunds the full token deposit after the grace period", async () => {
    const { context, program, tenant, landlord, mint, tenantAta, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initializeToken(new anchor.BN(40 * UNIT), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, mint, escrow, vault, tenantAta, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc();

    await warpToUnix(context, leaseEnd + 4 * DAY);
    await program.methods
      .releaseToken()
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, mint, escrow, vault, tenantAta, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();

    assert.equal(await tokenBalance(context, tenantAta), 100 * UNIT, "tenant whole again");
    assert.equal(await tokenBalance(context, vault), 0, "vault drained");
    const acct = await (program.account as any).tokenEscrow.fetch(escrow);
    assert.deepEqual(acct.state, { released: {} });
  });

  it("close_token: closes the vault and data account after settlement", async () => {
    const { context, program, tenant, landlord, mint, tenantAta, landlordAta, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initializeToken(new anchor.BN(50 * UNIT), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, mint, escrow, vault, tenantAta, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc();
    await warpToUnix(context, leaseEnd + DAY);
    await program.methods
      .fileClaimToken(new anchor.BN(20 * UNIT))
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, mint, escrow })
      .signers([landlord])
      .rpc();
    await program.methods
      .acceptClaimToken()
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, mint, escrow, vault, landlordAta, tenantAta, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();

    await program.methods
      .closeToken()
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, mint, escrow, vault, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();

    assert.equal(await tokenBalance(context, vault), 0);
    const vaultAcct = await context.banksClient.getAccount(vault);
    assert.isTrue(vaultAcct === null || vaultAcct.lamports === 0, "vault account closed");
    const escrowAcct = await context.banksClient.getAccount(escrow);
    assert.isTrue(escrowAcct === null || escrowAcct.lamports === 0, "data account closed");
  });
});

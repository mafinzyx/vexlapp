import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock } from "solana-bankrun";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";
import IDL from "../target/idl/deposit_escrow.json";

const PROGRAM_ID = new PublicKey(IDL.address);
const DAY = 24 * 60 * 60;

// Build a fresh, funded provider/program for each test (full isolation).
async function setup() {
  const context = await startAnchor(
    "",
    [{ name: "deposit_escrow", programId: PROGRAM_ID }],
    []
  );
  const provider = new BankrunProvider(context);
  anchor.setProvider(provider);
  const program = new Program(IDL as anchor.Idl, provider);

  const tenant = provider.wallet.payer; // funded by bankrun
  const landlord = Keypair.generate();

  const [escrow] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      landlord.publicKey.toBuffer(),
      tenant.publicKey.toBuffer(),
    ],
    PROGRAM_ID
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), escrow.toBuffer()],
    PROGRAM_ID
  );

  return { context, provider, program, tenant, landlord, escrow, vault };
}

// Bankrun lets us jump the validator clock forward to test time-locked logic.
async function warpToUnix(context: any, unixSeconds: number) {
  const clock: Clock = await context.banksClient.getClock();
  context.setClock(
    new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(unixSeconds)
    )
  );
}

async function nowUnix(context: any): Promise<number> {
  return Number((await context.banksClient.getClock()).unixTimestamp);
}

async function lamports(context: any, pk: PublicKey): Promise<number> {
  const acct = await context.banksClient.getAccount(pk);
  return acct ? Number(acct.lamports) : 0;
}

describe("deposit-escrow", () => {
  // ---- Task 1: initialize ----
  it("initialize: locks the deposit in the vault PDA", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const amount = new anchor.BN(2 * LAMPORTS_PER_SOL);
    const leaseEnd = new anchor.BN((await nowUnix(context)) + 30 * DAY);

    await program.methods
      .initialize(amount, leaseEnd)
      .accounts({
        tenant: tenant.publicKey,
        landlord: landlord.publicKey,
        escrow,
        vault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const acct = await program.account.depositEscrow.fetch(escrow);
    assert.equal(acct.amount.toString(), amount.toString());
    assert.deepEqual(acct.state, { active: {} });
    assert.equal(await lamports(context, vault), amount.toNumber());
  });

  // ---- Task 2: file_claim ----
  it("file_claim: rejected before lease end", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = new anchor.BN((await nowUnix(context)) + 30 * DAY);
    await program.methods
      .initialize(new anchor.BN(2 * LAMPORTS_PER_SOL), leaseEnd)
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();

    let failed = false;
    try {
      await program.methods
        .fileClaim(new anchor.BN(LAMPORTS_PER_SOL))
        .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
        .signers([landlord])
        .rpc();
    } catch (e: any) {
      failed = true;
      assert.include(e.toString(), "LeaseNotEnded");
    }
    assert.isTrue(failed, "expected LeaseNotEnded");
  });

  it("file_claim: succeeds after lease end and sets ClaimFiled", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initialize(new anchor.BN(2 * LAMPORTS_PER_SOL), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();

    await warpToUnix(context, leaseEnd + DAY);
    await program.methods
      .fileClaim(new anchor.BN(LAMPORTS_PER_SOL))
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
      .signers([landlord])
      .rpc();

    const acct = await program.account.depositEscrow.fetch(escrow);
    assert.deepEqual(acct.state, { claimFiled: {} });
    assert.equal(acct.claimAmount.toString(), new anchor.BN(LAMPORTS_PER_SOL).toString());
  });

  it("file_claim: rejected when claim exceeds deposit", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initialize(new anchor.BN(LAMPORTS_PER_SOL), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await warpToUnix(context, leaseEnd + DAY);

    let failed = false;
    try {
      await program.methods
        .fileClaim(new anchor.BN(5 * LAMPORTS_PER_SOL))
        .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
        .signers([landlord])
        .rpc();
    } catch (e: any) {
      failed = true;
      assert.include(e.toString(), "ClaimExceedsDeposit");
    }
    assert.isTrue(failed);
  });

  // ---- Task 3: accept_claim ----
  it("accept_claim: splits deposit between landlord and tenant, empties vault", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    const deposit = 2 * LAMPORTS_PER_SOL;
    const claim = 1 * LAMPORTS_PER_SOL;

    await program.methods
      .initialize(new anchor.BN(deposit), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await warpToUnix(context, leaseEnd + DAY);
    await program.methods
      .fileClaim(new anchor.BN(claim))
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
      .signers([landlord])
      .rpc();

    const landlordBefore = await lamports(context, landlord.publicKey);
    await program.methods
      .acceptClaim()
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();

    assert.equal((await lamports(context, landlord.publicKey)) - landlordBefore, claim);
    assert.equal(await lamports(context, vault), 0, "vault drained");
    const acct = await program.account.depositEscrow.fetch(escrow);
    assert.deepEqual(acct.state, { settled: {} });
  });

  // ---- Task 4: dispute_claim ----
  it("dispute_claim: tenant freezes funds within the window", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initialize(new anchor.BN(2 * LAMPORTS_PER_SOL), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await warpToUnix(context, leaseEnd + DAY);
    await program.methods
      .fileClaim(new anchor.BN(LAMPORTS_PER_SOL))
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
      .signers([landlord])
      .rpc();

    await program.methods
      .disputeClaim()
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow })
      .rpc();

    const acct = await program.account.depositEscrow.fetch(escrow);
    assert.deepEqual(acct.state, { disputed: {} });
  });

  it("dispute_claim: rejected after the response deadline", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initialize(new anchor.BN(2 * LAMPORTS_PER_SOL), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await warpToUnix(context, leaseEnd + DAY);
    await program.methods
      .fileClaim(new anchor.BN(LAMPORTS_PER_SOL))
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
      .signers([landlord])
      .rpc();

    await warpToUnix(context, leaseEnd + DAY + 6 * DAY); // past the 5-day window
    let failed = false;
    try {
      await program.methods
        .disputeClaim()
        .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow })
        .rpc();
    } catch (e: any) {
      failed = true;
      assert.include(e.toString(), "ClaimExpired");
    }
    assert.isTrue(failed);
  });

  // ---- Task 5: claim_timeout ----
  it("claim_timeout: settles to landlord after the deadline", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    const deposit = 2 * LAMPORTS_PER_SOL;
    const claim = 1 * LAMPORTS_PER_SOL;
    await program.methods
      .initialize(new anchor.BN(deposit), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await warpToUnix(context, leaseEnd + DAY);
    await program.methods
      .fileClaim(new anchor.BN(claim))
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
      .signers([landlord])
      .rpc();

    await warpToUnix(context, leaseEnd + DAY + 6 * DAY); // past 5-day window
    const landlordBefore = await lamports(context, landlord.publicKey);
    await program.methods
      .claimTimeout()
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();

    assert.equal((await lamports(context, landlord.publicKey)) - landlordBefore, claim);
    const acct = await program.account.depositEscrow.fetch(escrow);
    assert.deepEqual(acct.state, { settled: {} });
  });

  it("claim_timeout: rejected before the deadline", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initialize(new anchor.BN(2 * LAMPORTS_PER_SOL), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await warpToUnix(context, leaseEnd + DAY);
    await program.methods
      .fileClaim(new anchor.BN(LAMPORTS_PER_SOL))
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
      .signers([landlord])
      .rpc();

    let failed = false;
    try {
      await program.methods
        .claimTimeout()
        .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
        .rpc();
    } catch (e: any) {
      failed = true;
      assert.include(e.toString(), "ClaimNotExpired");
    }
    assert.isTrue(failed);
  });

  // ---- Task 6: release ----
  it("release: full refund to tenant after grace period with no claim", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    const deposit = 2 * LAMPORTS_PER_SOL;
    await program.methods
      .initialize(new anchor.BN(deposit), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();

    await warpToUnix(context, leaseEnd + 4 * DAY); // past 3-day grace
    const tenantBefore = await lamports(context, tenant.publicKey);
    await program.methods
      .release()
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();

    // Vault must be fully drained, and the tenant receives the whole deposit
    // (here the tenant is also the fee payer, so allow for one tx fee).
    assert.equal(await lamports(context, vault), 0, "vault drained");
    const delta = (await lamports(context, tenant.publicKey)) - tenantBefore;
    assert.isAtLeast(delta, deposit - 10000);
    assert.isAtMost(delta, deposit);
    const acct = await program.account.depositEscrow.fetch(escrow);
    assert.deepEqual(acct.state, { released: {} });
  });

  it("release: rejected before the grace period ends", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initialize(new anchor.BN(2 * LAMPORTS_PER_SOL), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();

    await warpToUnix(context, leaseEnd + DAY); // only 1 day, grace is 3
    let failed = false;
    try {
      await program.methods
        .release()
        .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
        .rpc();
    } catch (e: any) {
      failed = true;
      assert.include(e.toString(), "TooEarlyToRelease");
    }
    assert.isTrue(failed);
  });

  // ---- Negative / adversarial ----
  it("file_claim: rejected when signed by someone other than the landlord", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initialize(new anchor.BN(2 * LAMPORTS_PER_SOL), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await warpToUnix(context, leaseEnd + DAY);

    const attacker = Keypair.generate();
    let failed = false;
    try {
      // Pass the real landlord pubkey but sign as the attacker — no landlord signature.
      await program.methods
        .fileClaim(new anchor.BN(LAMPORTS_PER_SOL))
        .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
        .signers([attacker])
        .rpc();
    } catch (e: any) {
      failed = true;
    }
    assert.isTrue(failed, "a non-landlord must not be able to file a claim");
  });

  it("accept_claim: rejected when signed by someone other than the tenant", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initialize(new anchor.BN(2 * LAMPORTS_PER_SOL), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await warpToUnix(context, leaseEnd + DAY);
    await program.methods
      .fileClaim(new anchor.BN(LAMPORTS_PER_SOL))
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
      .signers([landlord])
      .rpc();

    const attacker = Keypair.generate();
    let failed = false;
    try {
      await program.methods
        .acceptClaim()
        .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
        .signers([attacker])
        .rpc();
    } catch (e: any) {
      failed = true;
    }
    assert.isTrue(failed, "a non-tenant must not be able to accept a claim");
  });

  it("accept_claim: rejected a second time (already settled)", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initialize(new anchor.BN(2 * LAMPORTS_PER_SOL), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await warpToUnix(context, leaseEnd + DAY);
    await program.methods
      .fileClaim(new anchor.BN(LAMPORTS_PER_SOL))
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
      .signers([landlord])
      .rpc();
    await program.methods
      .acceptClaim()
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();

    let failed = false;
    try {
      await program.methods
        .acceptClaim()
        .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
        .rpc();
    } catch (e: any) {
      failed = true;
    }
    assert.isTrue(failed, "double settlement must be rejected");
    // State must remain Settled — no second payout happened.
    const acct = await program.account.depositEscrow.fetch(escrow);
    assert.deepEqual(acct.state, { settled: {} });
  });

  // ---- close_escrow (rent reclamation) ----
  it("close_escrow: rejected while the escrow is still active", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initialize(new anchor.BN(2 * LAMPORTS_PER_SOL), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();

    let failed = false;
    try {
      await program.methods
        .closeEscrow()
        .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow })
        .rpc();
    } catch (e: any) {
      failed = true;
      assert.include(e.toString(), "NotClosable");
    }
    assert.isTrue(failed, "an active escrow must not be closable");
  });

  it("close_escrow: closes the data account and returns rent after settlement", async () => {
    const { context, program, tenant, landlord, escrow, vault } = await setup();
    const leaseEnd = (await nowUnix(context)) + 30 * DAY;
    await program.methods
      .initialize(new anchor.BN(2 * LAMPORTS_PER_SOL), new anchor.BN(leaseEnd))
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();
    await warpToUnix(context, leaseEnd + DAY);
    await program.methods
      .fileClaim(new anchor.BN(LAMPORTS_PER_SOL))
      .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
      .signers([landlord])
      .rpc();
    await program.methods
      .acceptClaim()
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();

    const rent = await lamports(context, escrow); // data account's rent reserve
    assert.isAbove(rent, 0);
    const tenantBefore = await lamports(context, tenant.publicKey);

    await program.methods
      .closeEscrow()
      .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, escrow })
      .rpc();

    // Data account is gone, and its rent went back to the tenant.
    assert.equal(await lamports(context, escrow), 0, "escrow account closed");
    const tenantAfter = await lamports(context, tenant.publicKey);
    assert.isAtLeast(tenantAfter - tenantBefore, rent - 10000);
  });
});

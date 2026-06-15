# Deposit Escrow — trustless rental security deposits on Solana

A non-custodial escrow for rental security deposits, written as an on-chain Rust
(Anchor) program. The tenant's deposit is locked in a program-controlled vault —
**neither the landlord nor the tenant can move it unilaterally.** Funds are
released only by rules enforced on-chain.

> Built for the *"Build Everyday Real-World Systems as On-Chain Rust Programs"* challenge.

- **Program ID (devnet):** [`Em436QuUeGG4g6ErrABWnbjjDBEPLnzoPVDXmQ6o2hYm`](https://explorer.solana.com/address/Em436QuUeGG4g6ErrABWnbjjDBEPLnzoPVDXmQ6o2hYm?cluster=devnet)
- **Status:** deployed to devnet, full lifecycle verified with real transactions (links below)

---

## The problem

A rental security deposit is one of the most common escrow arrangements on earth,
and it is broken almost everywhere:

- **The landlord holds the cash.** The tenant has no guarantee it comes back, and
  no visibility into where it sits.
- **Disputes are word-against-word.** "You broke it" vs "it was already like that",
  with no neutral record.
- **Recovery is expensive.** Getting an unfairly withheld deposit back means
  small-claims court — for a sum often smaller than the cost of pursuing it.
- **The reverse is just as bad.** A tenant can vanish, leaving real damage and a
  landlord with no quick recourse.

The core issue: **one party physically controls money that belongs to the situation,
not to them.**

## The Solana solution

Put the deposit somewhere *neither party controls* — a Program Derived Address —
and let code, not a person, enforce the agreed rules.

- The deposit lives in a **vault PDA**. There is no private key for it; only the
  program can move its lamports, and only along the paths below.
- Every transition is **time-boxed on-chain**, which kills the obvious attacks:
  a landlord can't grab the deposit mid-lease, and funds can't be frozen forever
  by one side simply refusing to act.
- Every action is a **public, auditable transaction**.

Solana specifically: deposits are small and time-sensitive, so sub-cent fees and
sub-second finality matter — a deposit escrow that cost \$20 in gas and took a day
to settle would defeat its own purpose.

---

## Architecture

### State machine

```
                 initialize
                     │
                     ▼
                 ┌────────┐   release  (>= lease_end + 3d, no claim filed)   ┌──────────┐
                 │ Active │ ─────────────────────────────────────────────────▶│ Released │
                 └────────┘                                                    └──────────┘
                     │ file_claim (only AFTER lease_end)
                     ▼
                ┌───────────┐  accept_claim  ──────────────▶ ┌─────────┐
                │ ClaimFiled│  claim_timeout (> deadline) ───▶│ Settled │
                └───────────┘                                 └─────────┘
                     │ dispute_claim (within 5-day window)
                     ▼
                ┌──────────┐
                │ Disputed │   funds frozen — off-chain arbitration (see Limitations)
                └──────────┘
```

### Two PDAs (and why)

| PDA | Seeds | Holds | Purpose |
|---|---|---|---|
| `escrow` (data) | `["escrow", landlord, tenant]` | agreement state | who / how much / deadlines / status |
| `vault` | `["vault", escrow]` | deposit lamports only | the actual money, kept separate |

The deposit is held in a **separate vault PDA**, not in the data account. This keeps
the deposit lamports from ever mixing with the data account's rent-exempt reserve —
so a payout can never accidentally drain the rent and corrupt the account
mid-agreement. Funds leave the vault only via `invoke_signed` transfers the program
authorizes.

### Time locks

| Lock | Value | Prevents |
|---|---|---|
| `lease_end` (set at init) | tenant-chosen | landlord claiming **before the lease is even over** |
| Claim response window | 5 days | landlord locking the tenant's money forever by filing a claim |
| Release grace period | 3 days after `lease_end` | tenant yanking the deposit the instant the lease ends, before the landlord can inspect |

---

## Instructions

| Instruction | Caller | Pre-conditions | Effect |
|---|---|---|---|
| `initialize(amount, lease_end)` | tenant | `lease_end` in the future | locks `amount` in the vault, state → `Active` |
| `file_claim(claim_amount)` | landlord | now ≥ `lease_end`, state `Active`, `claim_amount ≤ deposit` | state → `ClaimFiled`, opens 5-day window |
| `accept_claim()` | tenant | state `ClaimFiled` | pays landlord the claim, refunds rest to tenant, → `Settled` |
| `dispute_claim()` | tenant | state `ClaimFiled`, within window | state → `Disputed`, vault frozen |
| `claim_timeout()` | anyone | state `ClaimFiled`, window elapsed | settles in landlord's favor, → `Settled` |
| `release()` | anyone | state `Active`, now ≥ `lease_end + 3d` | full refund to tenant, → `Released` |

`claim_timeout` and `release` are **permissionless** — anyone can crank them once the
clock allows, so funds never get stuck because the party who benefits forgot to act.

---

## Honest limitations

This is the part most "trustless rental" demos skip. The chain **cannot inspect a
physical apartment.** It does not know whether the carpet is actually stained.

So this program does **not** pretend to adjudicate damage. What it does:

- Removes custody risk entirely — no one can run off with the deposit.
- Enforces *timing and process* fairness — no early claims, no indefinite freezes,
  no unilateral withdrawals.
- When the tenant genuinely disagrees, `dispute_claim` moves the escrow to a
  terminal **`Disputed`** state and **freezes the vault**. On-chain, that's the
  honest endpoint: the money is safe and untouched, and resolution moves to an
  off-chain arbiter (a clause in the lease, a mediator, or a court). The program
  guarantees the funds are exactly where everyone left them while that plays out.

A future version could add a designated arbiter key or an escrow-DAO vote to resolve
`Disputed` on-chain — deliberately out of scope here, because a half-built "trustless
judge" is worse than an honest hand-off.

---

## Live on devnet

The full happy path, run end-to-end with real SOL on devnet:

| Step | What happened | Transaction |
|---|---|---|
| Deploy | program published | [`GtztEz…sevHZt`](https://explorer.solana.com/tx/GtztEzwAWe1dVm2LRMXEZsgKfvMp5woYhbzE9cvcATb1Va7EuEmSaawFovHzGymdrZGPPLyUGXTGauq29sevHZt?cluster=devnet) |
| `initialize` | tenant locks 0.2 SOL | [`DV8Wsi…18MykX`](https://explorer.solana.com/tx/DV8Wsit7zhUPQ9nZzeUEfHod3GQNoD5EsfnPFHNhbufr8rb9YiPSHYoiEJPktgAzDc6P4Doa4wMoQ2Nht18MykX?cluster=devnet) |
| `file_claim` | landlord claims 0.08 SOL for damage | [`4iqnyt…dko7`](https://explorer.solana.com/tx/4iqnytoP4m4KeS18QEumKun7KFMmpmcyAyq3Vx629DpkuRAzsDCQxa9e2Pok6MpG2etk4ZMgbuyC3Kg1H2ezdko7?cluster=devnet) |
| `accept_claim` | tenant accepts → 0.08 to landlord, 0.12 back to tenant | [`5xFrsf…3CDt`](https://explorer.solana.com/tx/5xFrsfSeoVfj24eHC71jnpiY7f3BsaHpRgrpLy6He8VTqPaad1Xqekvha813oR2KcnPT1Q85hS61FGZwWtKV3CDt?cluster=devnet) |

Accounts from that run:
- escrow PDA: [`FK3H74F5rco2bpH8Bcy3Mpd5QmDrErDY9Fi5j7k5DqyR`](https://explorer.solana.com/address/FK3H74F5rco2bpH8Bcy3Mpd5QmDrErDY9Fi5j7k5DqyR?cluster=devnet)
- vault PDA: [`D2Z6VhGrQzKLqxxiGhgognBy6TeeAgNd8TrHdVa9rFqA`](https://explorer.solana.com/address/D2Z6VhGrQzKLqxxiGhgognBy6TeeAgNd8TrHdVa9rFqA?cluster=devnet)

---

## Tests

All six instructions and their edge cases are covered by an
[`anchor-bankrun`](https://github.com/kevinheavey/anchor-bankrun) suite (11 tests).
Bankrun runs against the real SBF program in-process and lets us **warp the validator
clock**, which is the only practical way to test the lease-end gate, the 5-day claim
window, and the 3-day release grace.

```
deposit-escrow
  ✔ initialize: locks the deposit in the vault PDA
  ✔ file_claim: rejected before lease end
  ✔ file_claim: succeeds after lease end and sets ClaimFiled
  ✔ file_claim: rejected when claim exceeds deposit
  ✔ accept_claim: splits deposit between landlord and tenant, empties vault
  ✔ dispute_claim: tenant freezes funds within the window
  ✔ dispute_claim: rejected after the response deadline
  ✔ claim_timeout: settles to landlord after the deadline
  ✔ claim_timeout: rejected before the deadline
  ✔ release: full refund to tenant after grace period with no claim
  ✔ release: rejected before the grace period ends

  11 passing
```

---

## Run it yourself

Prerequisites: Rust, Solana CLI, Anchor (`anchor-cli` 1.0.2), Node/yarn.

```bash
# build the program + generate the IDL
anchor build

# run the full test suite (no validator needed — bankrun runs in-process)
yarn test
```

Drive the live program on devnet with the CLI (the default Solana wallet acts as the
tenant; a landlord keypair is generated at `cli/landlord.json`):

```bash
yarn cli init 0.2 30        # tenant locks 0.2 SOL, lease ends in 30s
yarn cli fund-landlord 0.05 # give the landlord SOL for fees
yarn cli show               # inspect on-chain escrow state
# after lease_end:
yarn cli file-claim 0.08    # landlord claims 0.08 SOL for damage
yarn cli accept             # tenant accepts → deposit split
# alternatives: yarn cli dispute | yarn cli timeout | yarn cli release
```

## Project layout

```
programs/deposit-escrow/src/lib.rs   the on-chain program (6 instructions, 2 PDAs)
tests/deposit-escrow.ts              bankrun test suite (11 tests)
cli/index.ts                         devnet CLI for the full lifecycle
```

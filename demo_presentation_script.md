# Demo Presentation Script

This is the clean judge-facing flow for the hackathon demo.

Use the terminal UI here:
- Local: `http://localhost:8787/demo/terminal`
- Hosted: `https://pusd-demo-worker.riasols.workers.dev/demo/terminal`

## Demo Order

1. Show the terminal UI landing screen
2. Explain the stack in one sentence
3. Run the guided demo
4. Pause after each major step and call out the proof
5. Close with the x402 machine-payment moment

This order is deliberate:
- first establish credibility
- then prove the fiat rail
- then prove private custody
- then prove redemption
- then prove autonomous payment

## What The UI Should Show

The UI is designed to be a single-screen command center:
- terminal-style event log on the right
- simple action buttons on the left
- a single `Run Guided Demo` button for the smoothest presentation
- no complex navigation

What to enter before starting:
1. Paste the admin token
2. Leave the user as `judge-demo`, or set a fresh demo user
3. Click `Run Guided Demo`

## Judge Script

Use this almost verbatim if you want a tight 2-3 minute story.

### Opening

“This is `PUSD`, Private USD. It is a dollar-backed stablecoin on Monad testnet. The important difference is that onramp and offramp are tied to a real banking rail through Column, and once funds are minted, the balance moves privately through Unlink.”

“So what you are about to watch is not a mock blockchain widget. It is a real fiat movement, a real onchain mint, a real private transfer, a real onchain burn, and then a machine-payment flow on top.”

### Step 1: Public Metadata

“First, I show the public metadata. This proves the app is live, we are on Monad testnet, and the token standard is EIP-3009 so it is compatible with x402-style payment flows.”

Expected visual:
- the log shows `Public metadata`
- chain id `10143`
- token `PUSD`

### Step 2: Reset State

“Now I reset the demo state so the judges can see a clean run from zero.”

Expected visual:
- the log shows `State reset`

### Step 3: Column Smoke

“Before I even touch the token, I prove the banking side is real. This step creates real sandbox banking objects in Column, simulates incoming fiat, and executes a real book transfer.”

“This is important because our stablecoin is not floating against imaginary reserves. The reserve accounting starts from the banking rail.”

Expected visual:
- `Column smoke completed`
- real `reserveEntityId`
- real `reserveBankAccountId`
- real `bookTransferId`

### Step 4: Unlink Smoke

“Next I prove the privacy runtime is actually alive. The Worker is calling a Cloudflare Container that runs the Unlink Node SDK, and it creates a managed private wallet.”

“This confirms the privacy leg is not a fallback path.”

Expected visual:
- `Unlink container healthy`
- `mode: "container"`
- `sdkAvailable: true`
- `fallbackUsed: false`

### Step 5: Mint / Onramp

“Now I onramp. This creates a mint intent for 321 cents.”

“Behind the scenes, three real things happen in sequence:
one, fiat moves by Column book transfer into reserve;
two, `PUSD` is minted on Monad;
three, the minted value is deposited into Unlink so the user’s balance is private.”

“The key proof is the log shows all three identifiers: a real Column transfer id, a real Monad transaction hash, and a real Unlink operation.”

Expected visual:
- `Mint intent created`
- poll status updates
- `Mint completed`
- real `book_...`
- real Monad tx hash
- real Unlink tx hash embedded in `unlink_operation_id`

### Step 6: Balances After Mint

“Now I show the balance snapshot. The user’s fiat is down by 321 cents, their private `PUSD` is up by 321 cents, and the system reserve and supply both reflect exactly that amount.”

“So the reserve and the stablecoin supply stay in lockstep.”

Expected visual:
- `fiatCents: 499679`
- `privatePusdCents: 321`
- `reserveCents: 321`
- `totalSupplyCents: 321`

### Step 7: Burn / Offramp

“Now I redeem the full amount.”

“Again, three real things happen:
one, value exits Unlink privately;
two, `PUSD` is burned on Monad;
three, the reserve pays the user back through a real Column book transfer.”

“That means dollars do not leave reserve until the token supply is actually reduced.”

Expected visual:
- `Burn intent created`
- poll status updates
- `Burn completed`
- real Unlink withdraw tx
- real Monad burn tx
- real `book_...` payout transfer

### Step 8: Balances After Burn

“And now the final accounting check: the user’s fiat is fully restored, the private balance is zero, reserve is zero, and total supply is zero.”

“So the full loop returns to a clean state with no orphaned supply.”

Expected visual:
- `fiatCents: 500000`
- `privatePusdCents: 0`
- `reserveCents: 0`
- `totalSupplyCents: 0`

### Step 9: x402 Machine Payment

“The last layer is what makes this useful for autonomous agents.”

“Here I trigger an x402-style paid endpoint. It first returns a `402 Payment Required` challenge. The system then ensures funds, moves the value into the shared payer path, settles the challenge, and retries automatically.”

“So an agent can start with fiat, convert into `PUSD`, and then satisfy a paid API request without human intervention.”

Expected visual:
- `x402 challenge issued`
- `Shared payer funded`
- `Challenge settled`
- `x402 resource delivered`

Important wording:
- the UI should make clear this x402 settlement is `demo-ledger`
- do not claim it is a production facilitator rail

### Closing

“So the full product story is:
real dollars come in through Column,
private dollars live in Unlink,
token supply is enforced on Monad,
and the same value can power machine-native payments.”

“That means we are combining real banking rails, private onchain custody, and programmable AI payments in a single flow.”

## If Judges Ask Follow-Ups

### “What is actually private?”

“The user’s ongoing balance and transfers are private once the value is inside Unlink. The pool entry and exit are still public-chain boundary events, but the user never needs to publicly hold `PUSD` in their own wallet.”

### “Is the banking side real?”

“Yes. The Worker performs real Column sandbox entity creation, bank account creation, simulated funding, and real book transfers.”

### “Is the chain side real?”

“Yes. The mint and burn are real Monad testnet transactions, and the token is deployed onchain.”

### “Is the x402 payment fully onchain?”

“The user experience and retry loop are real, but the final facilitator settlement in this demo is explicitly labeled `demo-ledger`. That part is the demo abstraction, not the privacy, mint, burn, or banking rails.”

## Practical Demo Notes

1. Use a fresh browser tab with the terminal UI already loaded.
2. Paste the admin token before judges arrive.
3. Keep the user id stable for one clean run.
4. Prefer `Run Guided Demo` unless a judge asks to inspect a specific step.
5. If you want to slow down for explanation, use the individual buttons in this order:
   - `Show Public Metadata`
   - `Reset State`
   - `Column Smoke`
   - `Unlink Smoke`
   - `Mint 321c`
   - `Balances`
   - `Burn 321c`
   - `Balances`
   - `Run x402 Flow`

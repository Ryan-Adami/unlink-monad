# Demo Presentation Script

Use the terminal UI here:
- Local: `http://localhost:8787/demo/terminal`
- Hosted: `https://pusd-demo-worker.riasols.workers.dev/demo/terminal`

This version is built around a plain-English buyer story:
- create a new bank-linked buyer
- let the buyer ask an AI shopping agent for help
- convert cash into private dollars only when the buyer confirms
- pay a machine checkout with x402
- cash out the leftover private balance

## Recommended Live Order

1. Open the terminal UI
2. Paste the admin token
3. Leave the buyer name as a fresh value
4. Leave the shopping prompt as-is or type a new one
5. Click `Run Full Buyer Demo`

That one button runs the full story in the right order.

If you want to drive it manually, use this order:
1. `Reset Everything (Fresh Demo Start)`
2. `Clear Live Event Stream` (optional, if you want a visually clean pane without resetting state)
3. `1. Show Live System Info`
4. `2. Create Buyer + Add Starter Cash`
5. `3. Ask AI Shopping Agent`
6. `4. Check Cash + Private USD`
7. `5. Confirm Purchase + Pay Privately`
8. `6. Cash Out Leftover Private USD`

The numbered buttons are the best mode when you want to pause after each step and explain the proof in the log.

## What To Say

### Opening

“This demo shows the full buyer journey for Private USD. We start with regular cash in a linked bank account, then an AI agent helps the user shop, and only when the user approves does the system privately convert cash into `PUSD` and complete the payment.”

“The important point is that the conversion is not manual and it is not public in the user’s wallet. The user starts with cash, the system moves value privately through Unlink, and the payment rail can still satisfy an x402-style machine checkout.”

### Step 1: Show The Live System

Click: `Show Live System Info`

Say:

“First I show the live stack. This worker is running on Cloudflare, the token is `PUSD` on Monad testnet, and the token standard is EIP-3009 so it can support x402-style payment flows.”

What to point at:
- chain id `10143`
- token `PUSD`
- live system metadata in the event stream

### Step 2: Create A Bank-Linked Buyer

Click: `Create Buyer Account + Add Starter Cash`

Say:

“Now I create a brand-new buyer. This step provisions a real sandbox bank account under our platform and seeds it with starter cash, so the judges can see this user is actually linked to the banking rail.”

“This is the user’s fiat starting point. No crypto yet.”

What to point at:
- `startingCashUsd`
- `linkedBankAccountId`
- `privateWalletId`
- `linkedBanking.bankAccountId`

### Step 3: Ask The AI Shopping Agent

Click: `Ask AI Shopping Agent`

Say:

“Now the buyer talks to an AI shopping agent. This response comes from the Cloudflare Workers AI binding. The buyer asks about buying something, and the agent comes back with a product suggestion and a checkout link.”

“The agent is not moving money yet. It is just preparing the purchase and asking for confirmation.”

What to point at:
- `mode: "cloudflare-ai"`
- the agent reply text
- the quoted checkout link
- the quoted price

### Step 4: Show There Is No Private Balance Yet

Click: `Check Cash And Private USD`

Say:

“Before the buyer confirms, I show the balances. The buyer still only has cash. The private `PUSD` balance is zero.”

“This matters because the conversion should happen on demand, not in advance.”

What to point at:
- `fiatCents`
- `privatePusdCents: 0`

### Step 5: Confirm Purchase And Pay Privately

Click: `Confirm Purchase + Pay Privately`

Say:

“Now the buyer approves the purchase. At this point the agent checks the private balance. If the buyer does not have enough `PUSD`, the agent uses the payment skill to convert cash into `PUSD` first.”

“Under the hood, the flow is: a book transfer moves cash into reserve, `PUSD` is minted on Monad, that value is deposited privately into Unlink, then just the payment amount is routed into the x402 payer path and the checkout request is retried.”

“So the conversion is automatic and private. The user does not manually move tokens.”

What to point at:
- the line saying the private balance is low
- the `Cash to PUSD conversion started` event
- the completed mint with:
  - real `book_...` transfer id
  - real Monad tx hash
  - real Unlink operation id
- the `Checkout link requested payment` event
- the `Agent used the payment skill` event
- the final `Checkout request succeeded` event

Important wording:
- say “private conversion” or “private onramp”
- do not say the x402 settlement itself is fully production onchain
- the UI labels that step as `demo-ledger`, which is accurate

### Step 6: Show The Leftover Private Balance

This happens automatically inside the previous step because the screen prints a balance snapshot at the end.

Say:

“I intentionally mint more than the checkout amount. That leaves a small private balance behind, so I can show the user does not get stuck in crypto. They can redeem the unused amount back into cash.”

What to point at:
- the post-purchase balance snapshot
- `privatePusdCents` should still be greater than `0`

### Step 7: Cash Out The Leftover Private USD

Click: `Cash Out Leftover Private USD`

Say:

“Now I redeem the remaining private balance back into regular cash. Value exits Unlink privately, `PUSD` is burned on Monad, and the linked bank account is credited back through the banking rail.”

“That closes the loop. The user can go from cash, to private dollars, to a machine payment, and then back to cash.”

What to point at:
- the `Cash-out started` event
- the completed burn with:
  - real Unlink withdraw tx
  - real Monad burn tx
  - real `book_...` payout transfer
- the final balance snapshot

### Closing

“So the full product story is simple: a real bank-linked user asks an AI agent to buy something, the agent privately converts cash into `PUSD` only when needed, pays a machine checkout, and then redeems the leftover balance back to cash.”

“That combines real banking rails, private onchain custody through Unlink, programmable settlement on Monad, and AI-native purchasing behavior in one flow.”

## Short 90-Second Version

If time is tight, say this:

“I start by creating a new bank-linked buyer with cash in their account. Then the buyer asks our AI shopping agent to find a product. When the buyer confirms, the agent sees there is no private `PUSD` yet, so it privately converts cash into `PUSD`, pays the x402-style checkout, and then I cash the leftover balance back into the bank account. The important part is that the user starts and ends with cash, while the token movement stays private in the middle.”

## Practical Notes

1. Use a fresh buyer name for each demo run.
2. Keep the shopping prompt focused on buying a physical item.
3. Let the event stream scroll; it is the proof surface for the demo.
4. Pause on ids and tx hashes only long enough to show they are real.
5. Emphasize the product sequence:
   - bank account
   - AI recommendation
   - buyer confirmation
   - private conversion
   - machine payment
   - cash-out

## Judge Follow-Ups

### “What is actually private?”

“The user’s token balance and transfers are private once the value is inside Unlink. The pool entry and exit are still visible boundary events, but the user never has to publicly hold `PUSD` in their own wallet.”

### “Is the AI step real?”

“Yes. The product recommendation response in this UI comes from the Cloudflare Workers AI binding.”

### “Is the banking side real?”

“Yes. The bank-linking and cash movement use real Column sandbox entities, bank accounts, seeded cash, and book transfers.”

### “Is the chain side real?”

“Yes. The mint and burn are real Monad testnet transactions and the Unlink movement is real.”

### “Is the x402 rail fully production?”

“The end-user flow is real, but the facilitator settlement in this demo is intentionally labeled `demo-ledger`. The private onramp, private custody, and mint/burn path are the real parts we are proving here.”

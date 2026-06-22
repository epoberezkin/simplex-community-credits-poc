# Threat Model — Community Credits

## 1. Purpose, scope, and the governing principle

Community Credits is a payment layer for **paywalled SimpleX communities**: users buy
stablecoin-backed vouchers and assign them to communities to subscribe; communities
redeem them with relay operators to cash out. This document states *what must stay
hidden, from whom, and why*, which on-chain facts are deliberately public, and **where
the current PoC falls short of the target and how to close the gap.**

**Target = the whitepaper's privacy goals.** This model is held to the goals in the
Community Credits whitepaper (§"Privacy Goals"/"Threat Model"): full unlinkability across
*purchase → assignment → redemption*, and **redemption that is unobservable as an event**
— an individual redemption should reveal neither its amount, nor which operator was paid,
nor which expiration cohort it belongs to, and redemptions must be unlinkable to one
another. Only *aggregate* operator earnings, surfaced at withdrawal, are public. The PoC
does not yet meet all of this; §6.1 and §7 record the gaps and the mitigations.

**Governing principle — do not weaken SimpleX.** SimpleX (simplexmq) already provides
metadata-private messaging and membership: who belongs to a community, who talks to
whom, and the social graph are not exposed. The credits layer is an *add-on*. Its
binding requirement is that **it must not introduce any deanonymization channel that
SimpleX otherwise prevents.** Concretely: nothing on-chain may let an observer learn a
community's membership or attribute on-chain activity to a specific community.

**In scope:** the on-chain privacy and integrity of the credits protocol
(`buyAndCreate` / `assign` / `redeem` / `withdraw`), and what a third party can infer
from public chain data.

**Out of scope (assumed handled elsewhere):** SimpleX's own guarantees; user device
and key security; the network/transport layer; and the link between a user's real
identity and the pseudonymous address they use on-chain — we assume the user takes
anonymization precautions (fresh address, private funding, network anonymity) so that
**the only thing a user leaks at purchase is a pseudonymous on-chain address.** The
protocol's job is to ensure that pseudonym can never be tied to a community or to
membership; tying the pseudonym to a real identity is the user's responsibility.

## 2. System sketch and on-chain visibility

Four on-chain operations. The community (`redeemerHash = Poseidon(communityId)`) is a
*private* circuit input in both assign and redeem and **never appears on-chain**. The
table separates what the **current PoC** publishes from the **target** (whitepaper) goal;
the delta is the hardening backlog.

| Operation      | Submitted by        | Public on-chain — current PoC                                           | Target (whitepaper)                                                                  |
|----------------|---------------------|------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `buyAndCreate` | buyer pseudonym     | buyer address, `value`, `expiryEpoch`, commitment, leaf index          | unchanged — entry is public, but `value` ∈ fixed denominations, `expiryEpoch` quarter-bucketed |
| `assign`       | a relay (fee-market)| nullifier, `expiryEpoch`, two output commitments, root, fee `F`         | same, but `expiryEpoch` bucketed; amounts already hidden (in commitments) ✓          |
| `redeem`       | an operator         | nullifier, **`expiryEpoch`, `redeemValue`, `operatorId`**, change commitment, root | hide all three: amount via redeem-side denominations *or* committed payout notes, **operator via payout-note unbinding**, cohort via bucketing |
| `withdraw`     | an operator         | operator address, `amount`                                             | operator identity public ✓; `amount` is the **aggregate** earning (intended disclosure) |

The user's pseudonym appears **only at `buyAndCreate`**; `assign` is relayed and
community-blind, so a member never signs an on-chain action that names their community.
The nullifier + ZK membership proof make each spend unlinkable to the commitment it
consumes, so `buy → assign → redeem` cannot be chained on-chain except by amount/timing
correlation — which the denomination and bucketing mitigations are designed to defeat.

### 2.1 Operator-visible vs public, and transaction timing

A foundational distinction runs through this model: what an operator learns **off-band**
(immediately, over SimpleX) is separate from what is **public on-chain**. The community
generates each redemption proof and hands the operator the cleartext `(value, opening)` in
the redemption message; the chain need only carry a hiding commitment. The operator
therefore knows the amount (and, as accepted in §3, the community) in real time, while an
on-chain observer does not. Two functional requirements pin this down:

- **F1 — Undelayed service.** An operator must learn a redemption's value the instant it
  receives the redemption, so tiered service starts without delay. *Satisfied off-band* —
  the redemption message carries the cleartext; the chain need not. This forbids any scheme
  that hides the amount from the *payee*, but it does **not** require revealing it publicly.
- **F2 — Double-spend protection.** An operator is protected against a re-spent or
  doubly-sent note only by getting its own `redeem`, and thus the note's nullifier, onto the
  chain. Verifying the proof off-band and checking the nullifier is only a snapshot; the
  spend is secured solely by winning the nullifier on-chain. So `redeem` must be submitted
  **immediately**, never batched.

These give three timing tiers; only the last is batchable, and amount-privacy lives there:

| Step       | Timing                | Carries on-chain                                                          |
|------------|-----------------------|--------------------------------------------------------------------------|
| `redeem`   | **immediate** (F2)    | nullifier (public), **committed** value, change commitment; operator hidden if payout notes (§7) are used |
| service    | immediate, off-band   | nothing (SimpleX message)                                                |
| `withdraw` | **batched / delayed** | the **aggregate** cleartext earning                                      |

Two consequences follow. First, because `redeem` cannot be delayed, the *event and its
timing* are unavoidably public — there is one on-chain redeem per redemption, and
"redemption unobservable as an event" (P5) means it carries **no identifying content** (no
amount, no operator, no cohort), not that the transaction is invisible. Second, an event you
cannot delay must *identify no one*: if the operator self-submits its immediate redeem from a
known address, the **tx sender re-leaks `operatorId`** even when the payload hides it — so
`redeem` must be included by a non-operator address (the permissionless **bearer-fee
includer** path of §7, or a rotated throwaway), with the operator's protection resting on
prompt, fee-incentivized inclusion.

## 3. Stakeholders: interests, anonymity, and disclosure

| Stakeholder         | Core interest                                                   | What "anonymity" means for them                          | Must stay hidden                                                                 | May / should be public                                             |
|---------------------|-----------------------------------------------------------------|----------------------------------------------------------|----------------------------------------------------------------------------------|--------------------------------------------------------------------|
| **User / member**   | Subscribe to a paywalled community without exposing it          | Their **membership is unlinkable** — to anyone           | Which community they belong to / pay into; any link from their pseudonym to a community or to other members | Their pseudonymous buy address, and that *some* address bought value `V` |
| **Community admin** | Run a paywalled community, collect payments, cash out, get tiered relay service | The **community is unattributable on-chain**             | The community's identity to the public; any per-community decomposition of on-chain activity; the member roster | The community's identity **to its own relay operator(s)**, off-chain, to access tiered service |
| **Relay operator**  | Run a transparent, accountable cash-out/relay service, earn fees | **Customer-set privacy** (they are not themselves anonymous) | **Which communities it serves**, and any *per-redemption* operator linkage that lets its aggregate be decomposed | Its identity and its **aggregate turnover/throughput** — public *by design*, at withdrawal granularity |

### 3.1 Users (members / subscribers)

Users buy vouchers to subscribe to paywalled communities. Their interest is access,
not exposure. **Anonymity = their community membership is hidden from everyone** —
relay operators, other members, and the public. The sensitive fact is the *association*
(this pseudonym → this community), not the payment itself. Users accept that a
pseudonymous address is visible at purchase; they do not accept that this pseudonym can
be connected to a community. Co-member anonymity is included: one member must not be
able to enumerate or identify the others.

### 3.2 Community admins

A community is willing to be **known to its relay operator(s)** off-chain — that
relationship is useful and intended, because operators offer tiered service to known
communities. What the admin needs is that the community stays **anonymous to the public
and to on-chain observers**, and in particular that *no on-chain figure can be decomposed
into per-community amounts, counts, or timing*. Being a known off-chain customer of an
operator is fine; having your community's redemption history readable *on the chain* is
not.

### 3.3 Relay operators

Operators are **publicly known and want their aggregate turnover public** — this is a
feature: transparent, auditable throughput builds trust and accountability. But "public
turnover" means the **aggregate disclosed at withdrawal**, *not* a per-redemption trail.
Their privacy interest is narrow and specific: **do not reveal which communities they
serve, and do not let individual redemptions be attributed to them** — because either
exposes their customer communities to targeting/censorship and makes the operator a
coercion point. This interest is *aligned* with the communities' and users' interests:
all three reduce to "no per-community on-chain attribution."

## 4. Adversaries and trust assumptions

- **On-chain observer (primary).** Reads all chain data, persistently and
  retroactively, correlates across time. Cannot break the ZK or the hashes.
- **Relay operator.** Honest-but-curious or coerced. *Knows the community it serves*
  (off-chain, accepted) but should be unable to learn that community's *members*, and
  should not be able to (or be coercible to) expose its customer set on-chain.
- **Co-member / infiltrator.** A member of a community trying to enumerate the others.
- **Censor / coercer.** Combines on-chain inference with off-chain pressure; succeeds if
  it can attribute on-chain activity to a specific community or learn an operator's
  customer set.
- **Indexer / data provider (honest-but-curious).** Whoever serves chain state and Merkle
  authentication paths to clients (a wallet scanning for its notes, a community fetching a
  path to build a redemption proof). In the adopted design this is a **relay-operated light
  client** reached over SimpleX onion transport: it observes *which* leaves a client asks for
  (query content) but not *who* asks (onion-hidden). Query content to the relay is an
  **accepted** disclosure (see T8 / §6.2), on the same footing as a relay already knowing the
  community it serves.

**Assumptions:** SimpleX provides metadata-private membership/messaging *and* the onion
transport over which clients reach a relay's light client (so the *querier's identity* is
hidden even if the *query content* is not); users apply anonymization precautions to their on-chain
pseudonym; circuits and the on-chain Poseidon are byte-equal so proofs are sound; the chain
and all events are public and permanent.

## 5. Properties to preserve

Privacy (the targets; §6.1 marks which are not yet met):

- **P1 — Membership privacy.** No party (operator, co-member, public) can link a user
  pseudonym to a community.
- **P2 — Community anonymity (public).** No on-chain observer can identify a community.
  (Known to its own operator off-chain is permitted.)
- **P3 — No per-community attribution.** No public on-chain figure — operator turnover,
  amounts, counts, or timing — may *decompose* into per-community quantities.
- **P4 — Flow unlinkability.** `buy → assign → redeem` cannot be chained on-chain.
- **P5 — Redemption unobservability (whitepaper goal).** An individual redemption reveals
  neither its **amount**, the **operator** paid, nor the **expiration cohort**, and
  redemptions are mutually unlinkable. Only *aggregate* operator earnings, surfaced at
  withdrawal, are public. (The redeem *transaction* and its timing remain public — F2 forbids
  hiding them; "unobservable as an event" means it carries no identifying content, not that
  no transaction appears.)
- **P6 — Operator transparency (a deliberate disclosure).** Operator identity and
  *aggregate* turnover are public at withdrawal; this is desired, not a leak. It does
  **not** extend to per-redemption operator linkage (that is hidden under P5).

Integrity / availability:

- **I1** No double-spend (nullifiers), **I2** no value creation / solvency holds,
  **I3** no theft or reroute of value, **I4** the service cannot be cheaply griefed into
  insolvency or state exhaustion, **I5** zero-trust settlement — the operator↔network
  revenue split is contract-enforced, not trusted.

**Meta-property (governing principle):** for every privacy property, the on-chain layer
must be *at least as strong* as SimpleX — it may not re-expose membership or community
attribution that the messaging layer hides.

## 6. Threats — what can leak on-chain

The community is cryptographically hidden in every operation, so the observer never sees
a community label. The residual risk is **reconstructing community-level attribution
from public metadata** — chiefly the operator, the amounts, and the expiration height.
T1–T7 are on-chain leaks; T8 is the one off-chain exception (the indexer read path),
listed here so the threat set is complete.

- **T1 — Pseudonym at entry.** `buyAndCreate` exposes a buyer pseudonym + `value`.
  *Accepted and bounded*: it must reveal only "an address bought `V`," never a community
  (P1). The danger is only if amount/timing later bridge it to a community (see T3).
- **T2 — Operator bucketing.** `operatorId` on `redeem` (and the matching
  `credit`/`withdraw`) buckets every redemption under a public operator. Fine as
  *aggregate* turnover (P6) but it **breaks P5 directly** (per-redemption operator is
  observable) and **breaks P3 when operator tenancy is low** — a single-tenant operator's
  public turnover *is* one community's. The whitepaper goal removes the per-redemption
  operator entirely.
- **T3 — Public amounts.** `value`, `redeemValue`, and `withdraw amount` are public.
  Distinctive amounts (a) fingerprint individual redemptions inside an operator's pile,
  (b) chain a public buyer's deposit to an operator's redemption across the ZK boundary
  by value + time (re-linking T1 → a community), and (c) let an operator's turnover be
  decomposed by amount. **Primary threat to P1, P3, and P5.**
- **T4 — Exit / redemption timing.** An operator that withdraws immediately / 1:1 after a
  redemption links its real-money settlement to that specific redemption, sharpening
  T2/T3 on the cash-out leg.
- **T5 — Expiration-height correlation.** `assign` and `redeem` publish the note's raw
  `expiryEpoch`. A distinctive expiry narrows a redemption to a small purchase cohort and
  can bridge redemption → purchase window (a channel against P4/P5).
- **T6 — Paymaster griefing / state exhaustion (I4).** `assign` is relay-sponsored,
  unprofitable, and opaque, so an attacker can spam tiny assigns to drain a relay's gas
  and consume the shared Merkle tree's leaves, limited only by proving effort.
- **T7 — Dusting / tainting.** Uniquely-valued micro-notes used to fingerprint and trail
  a user/community.
- **T8 — Query-pattern leak on the off-chain read path.** To build a proof a client fetches
  the Merkle path for the leaf it cares about, and to find incoming notes a wallet scans the
  tree; whoever serves those reads learns *which* leaf/note the client wants, even when onion
  transport hides *who* is asking. The adopted answer (§6.2) serves reads from a **relay-run
  light client over SimpleX onion routing**: the querier's identity is hidden, and the
  residual — query *content* visible to the relay — is **accepted**, on the same footing as a
  relay knowing the community it serves.

**Explicitly *not* threats in this model (deliberate disclosures):** a relay learning the
community it serves (off-chain, accepted); operator identity and *aggregate* turnover being
public (P6, desired); the **total stablecoin held by the pool** (TVL); and the **per-cohort
totals revealed when an expired bucket is reclaimed** — reclaim is aggregate-only and on a
verifiable per-bucket proof, never per-credit; and the **query content a relay's light client
sees** when it serves chain reads (the querier's identity is onion-hidden — see §6.2 / T8).
We do not spend effort hiding these.

### 6.1 Current PoC shortcomings vs the whitepaper goals

Honest status of where the PoC is weaker than the target:

- **Per-redemption operator is public (T2).** `redeem` publishes `operatorId`, so every
  redemption is attributed to a named operator on-chain. This violates **P5** outright and
  collapses **P3** for low-tenancy operators. *Target:* redemption reveals no operator.
- **Amounts are arbitrary and public (T3).** `value` / `redeemValue` / `withdraw amount`
  are free-form, so they fingerprint redemptions and bridge entry→operator→community.
  Violates **P3/P5** and weakens **P1**. *Target:* amounts are indistinguishable.
- **Expiration height is published raw (T5).** `assign`/`redeem` expose the exact
  `expiryEpoch`, narrowing redemptions to a fine purchase cohort. Weakens **P4/P5**.
  *Target:* only a coarse cohort is observable.
- **Withdrawal timing is behavioral (T4).** Nothing forces an operator to batch; an
  immediate 1:1 withdraw re-links settlement to a redemption. Weakens **P5**.
- **Privacy degrades to operator tenancy.** Even with the above closed, residual
  protection of P3 depends on operators mixing many communities — an operator-set property
  the chain cannot enforce.

What the PoC **already meets:** community is a private input (P1/P2), spends are unlinkable
to commitments via nullifier + ZK membership (P4, I1), assignment hides amount and
community (the commitments carry the value), and solvency/operator-registry/expiry-reclaim
hold (I2/I3).

### 6.2 Private blockchain access (query privacy)

Everything in §6 so far concerns what an observer reads from the *public ledger*. There is a
second, orthogonal channel the whitepaper treats as a first-class concern (its
"Private Blockchain Access" section): the **off-chain read path**. A client cannot act on
commitments it cannot see — to spend a note it must obtain that leaf's Merkle authentication
path, and to notice an incoming note it must scan the tree. Whoever serves those reads sees them.

Two sub-channels, deliberately separated:

- **Querier identity** — *who* is reading. Hidden by routing client→server requests over
  SimpleX's onion transport, so the server cannot tie a query to a network identity. This rides
  on the "do not weaken SimpleX" assumption and is the part the messaging layer already covers.
- **Query content** — *which* leaf/note/path is requested. Visible to whoever answers the read.

**Adopted design: a relay-run light client behind SimpleX onion routing.** Each relay runs a
light client that follows the chain itself (no third-party indexer) and answers clients' Merkle-
path / scan reads over an onion-routed SimpleX connection — using the resolver/transport
mechanism shipped in
[simplex-chat/simplexmq#1795](https://github.com/simplex-chat/simplexmq/pull/1795) ("SNRC name
resolver"). Onion routing strips the *querier's identity*, so the relay sees a stream of leaf
reads it cannot attribute to a network identity or a community. The residual — **query content is
public to the relay** — is **accepted**: it is the same trust boundary as a relay already knowing
the community it serves off-band (§3.2), and without the querier's identity the content does not
re-attribute on-chain activity to a community the way a named indexer query would.

If even content-to-the-relay must be hidden, stronger options exist — private-information-retrieval
reads, batched whole-subtree fetches, or oblivious / decoy query patterns — but they are not
required under the accepted boundary above and are out of scope for the PoC. The PoC's dapps today
read the chain directly (the chat dapp via a read-only RPC, rebuilding its mirror from events); the
relay-light-client + onion path is the production design. Tracked as T8.

## 7. Mitigations and requirements

Mapping threats to controls; "status" reflects the current PoC. The first four rows are
the privacy-hardening backlog that brings the PoC up to the whitepaper goals.

| Control                                                                 | Addresses        | Status                                                                                                                                                         |
|-------------------------------------------------------------------------|------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Fixed issuance denominations** — mint vouchers (`value` at `buyAndCreate`) only in a small standard set, so the public entry amount is low-cardinality and the buy→redeem bridge faces a large anonymity set | T3 (entry), T1-bridge, T7 | **Planned** — [#6](https://github.com/epoberezkin/simplex-community-credits-poc/issues/6)                                                                      |
| **Hide the redemption amount** (`redeemValue`) — commit the value per redeem, reveal only the **aggregate** at withdraw (F1/F2-compatible: the operator still gets cleartext off-band, redeem stays immediate). *Target:* committed **payout notes** — hides amount *and* operator together (next row). *Alternatives:* a committed per-operator balance with the operator still named (lighter, but leaves the per-operator redeem count/timing channel); AHE/ElGamal (**obviated** — aggregation in the withdrawal proof needs no homomorphic encryption, and on-chain accumulation would name the beneficiary; see notes); fixed redemption denominations (cleartext low-cardinality, weakest). **Bundling several redeems into one is ruled out by F2.** | T3 (redeem); P3/P5 | planned [#7](https://github.com/epoberezkin/simplex-community-credits-poc/issues/7)                                                                            |
| **Quarterly expiry bucketing** — client aligns each note's `expiryEpoch` to a coarse boundary (e.g. a quarter), so a wide range of purchases collapses to one published height | T5; P4/P5 | **Planned (client-side)** [#5](https://github.com/epoberezkin/simplex-community-credits-poc/issues/5)                                                          |
| **Payout-note unbinding** — operator-unbinding has **two independent legs, both required**. *Payload:* `redeem` carries a sealed payout note `Poseidon(amount, beneficiary, salt)` to a community/operator commitment instead of naming `operatorId`; the operator gets the opening off-band and later withdraws its accumulated total, the withdrawal proof showing only that it is the registered beneficiary of notes summing to the claimed aggregate. If the note's value is *committed* (not public) this also hides `redeemValue`, subsuming the redeem-amount row above. *Sender:* the immediate, undelayable redeem (§2.1/F2) must be included by a **non-operator** for a **bearer fee** carved from note value, else the tx sender re-leaks the operator even with the payload hidden | T2 + T3-redeem (value committed); P3/P5 (removes per-redemption operator) | **To be defined** — the whitepaper's "redemption-privacy gap" closure. candidate: [#8](https://github.com/epoberezkin/simplex-community-credits-poc/issues/8) |
| **Batched withdraw, enforced in-circuit** — withdraw proves `count ≥ N` ∨ `age ≥ T` over the payout notes it aggregates, so only blended aggregates ever settle; *unprovable* (a sub-N withdraw can't be formed), not contract-rejected (a reverted withdraw would still leak its aggregate to the mempool). Supersedes the behavioral exit buffer (accrue to `credit`, no 1:1). `N`, `T` are open deployment parameters | T4; P5 | **Planned (in-circuit)**  [#7](https://github.com/epoberezkin/simplex-community-credits-poc/issues/7)|
| **Operator multi-tenancy** (operators must mix many communities) — fallback for residual bucketing once the above land | T2 / P3 | **Required (deployment)** — single-tenant operators cannot be fully protected on-chain                                                                         |
| Community as a **private** input (`redeemerHash`) in assign & redeem    | P1, P2, P3       | **Implemented**                                                                                                                                                |
| Nullifier + ZK Merkle membership → spends unlinkable to commitments     | P4, I1           | **Implemented**                                                                                                                                                |
| Solvency invariant, operator registry, epoch expiry/reclaim, contract-enforced revenue split | I2, I3, I5 | **Implemented**                                                                                                                                                |
| **Private blockchain access** — each relay runs a **light client** and answers clients' Merkle-path / scan reads over **SimpleX onion routing** ([simplexmq#1795](https://github.com/simplex-chat/simplexmq/pull/1795)), hiding the *querier*; query *content* to the relay is accepted (same boundary as a relay knowing its community). PIR / batched / decoy reads remain optional for a stronger bar | T8; P1/P2/P4 | **Designed** — relay light client + onion transport; query content to the relay accepted. PoC dapps still read the chain directly |
| **Per-assign fee** (bearer, paid to the includer from note value)       | T6; enables permissionless/replaceable inclusion | **Planned** [#4](https://github.com/epoberezkin/simplex-community-credits-poc/issues/4)                                                                        |
| **Dust floor** (`destValue ≥ MIN`) — caps spam amplification & leaf use | T6 (capacity), T7| **Planned** [#3](https://github.com/epoberezkin/simplex-community-credits-poc/issues/3)                                                                        |
| User anonymization precautions for the pseudonym (out-of-protocol)      | T1               | **Assumed**                                                                                                                                                    |

Notes:

- **The amount channel has two independent legs.** *Issuance* (`value`) and *redemption*
  (`redeemValue`) are mitigated separately. Issuance denominations are planned and simple —
  the issuer mints standard sizes. Redemption is harder because a community cashes out an
  arbitrary accumulated balance; hiding `redeemValue` is closed by committed payout notes
  (the target), with fixed redemption denominations as a fallback. The two legs must *both* close
  for the buy→redeem amount bridge to be cut: denominated entry alone still leaks if
  `redeemValue` is a distinctive cleartext, and vice-versa.
- **Closing P3/P5 needs all the channels.** Entry + redeem amounts (above), expiry
  bucketing (T5), and per-redemption operator removal (T2, payout-note unbinding — both its
  payload and sender legs) must all
  land before an operator's public withdrawal becomes an *irreducible aggregate* that does
  not factor into per-community figures (P3/P5), matching the whitepaper.
- **Redemption-amount options compared.** Fixed redemption denominations make every
  `redeemValue` indistinguishable *unconditionally*, at the cost of more notes/leaves and
  forcing an arbitrary balance into standard chunks. Committed **payout notes** — a per-redeem
  commitment `Poseidon(amount, beneficiary, salt)` whose opening the operator gets off-band
  (F1) — hide `redeemValue` as a by-product of operator-unbinding (T2), closing the amount and
  operator channels at once; at withdrawal the operator sums the openings it holds and proves
  `aggregate = Σ amountᵢ` in-circuit. That is why payout notes are the target and a redeem-leg
  denomination scheme only a fallback.
- **AHE is obviated, not merely deprioritized.** On-chain additively-homomorphic accumulation
  requires the contract to know *which* per-operator accumulator each redeem adds into — which
  **names the beneficiary at redeem time**, the exact leak we set out to remove. Deferring the
  sum to the withdrawal proof avoids that, and since the operator already holds every opening
  off-band (F1), the aggregation is a plain in-circuit sum over commitments — no homomorphic
  encryption is needed at all. The price is O(N) withdrawal-proof work and an unrecoverable note
  if its opening is lost; both are acceptable (withdrawal is infrequent and runs on operator
  hardware, not mobile; note recovery is an open item, see #7).
- **Immediacy reshapes the choice (F1/F2).** Because `redeem` is immediate and `withdraw` is
  batched, amount-privacy must take the *commit-now / reveal-aggregate-at-withdraw* shape —
  not delaying or bundling redeems, which F2 forbids. The "size-one batch leaks" caveat
  therefore binds the *withdraw* cadence, not service: an operator serves immediately off-band
  but must accumulate ≥N redemptions before each withdraw (enforced in-circuit, next note). And since the immediate redeem
  event cannot be hidden, only emptied of content, the committed-**payout-note** (operator-
  hidden) form is preferred over a committed but operator-*named* balance, whose per-operator
  redeem count and timing still leak.
- **Withdraw batching is unprovable, not punished.** The `count ≥ N` ∨ `age ≥ T` floor is a
  *circuit constraint*, so a sub-N withdraw cannot be turned into a valid proof — there is no
  failing tx to broadcast. A contract-level `require()` would not achieve this: a reverted
  withdraw still leaks its aggregate to the mempool, so a reject is too late. Economic
  *punishment* of small batches is deliberately **not** used: the only actor who would push a
  revealing small withdraw is the operator, which already holds the cleartext off-band (F1)
  and can sell it to a censor off-chain for free — so on-chain punishment taxes a method the
  leaker doesn't need, adds a slashing/griefing surface, and reaches no off-chain whisper;
  unprovability removes the *verifiable* leak vector instead. Two honest limits: ≥N is a
  *granularity floor*, not a guarantee — a single-tenant operator's batch still sums to its
  one community regardless of `N`, so the real mixing is tenancy; and the `age ≥ T` escape
  keeps a low-volume operator's funds from being stranded, at the cost that its eventual aged
  withdraw is small-batch and leaky — which folds into the known low-tenancy residual. `N` and
  `T` are left as open deployment parameters.
- **Quarterly bucketing trades anonymity-set size against linkage.** A coarser bucket
  widens the cohort (more unlinkable) but a redemption then reveals a wider purchase
  window. Fully hiding the cohort requires blind per-bucket updates inside the proof
  (heavier redemption proof) — the whitepaper records this as an open decision; quarter
  bucketing is the cheap, partial mitigation the PoC can adopt now.
- **Multi-tenancy is a fallback, not the primary control.** Under the whitepaper goals,
  per-redemption operator linkage is *removed* (payout-note unbinding); tenancy then only
  guards the residual tail, rather than being the sole thing standing between an operator's
  turnover and a community.

## 8. Relationship to SimpleX and the whitepaper

SimpleX hides community membership and the social graph at the messaging layer. The
credits layer adds money, which is the classic place metadata privacy is lost. The
invariant is that **a community's membership and attribution must remain as hidden
on-chain as they are in SimpleX**:

- Membership that SimpleX hides (which user is in which community) must not be
  reconstructable from the chain (P1) — the pseudonym↔community link stays broken.
- A community SimpleX keeps unlinkable must stay unattributable on-chain (P2, P3).
- The credits layer may *reveal* only what is intentionally public (operator identity +
  *aggregate* turnover) and what is inherent at the entry point (a pseudonymous deposit).

The whitepaper sets the bar: full purchase→assignment→redemption unlinkability and
redemption that is unobservable as an event. Wherever a credits-layer disclosure is
strictly more revealing than that bar — today: arbitrary public amounts (T3), raw
expiration heights (T5), per-redemption `operatorId` (T2), and immediate withdrawals (T4)
— that is a gap to close before the system can be said
to meet the whitepaper goals and to "not weaken" SimpleX. The off-chain read path (T8) is not in
that list: it is handled by design — a relay-run light client behind SimpleX onion routing
(§6.2), with query content to the relay an accepted disclosure — and is implementation-pending,
not an open privacy gap. §6.1, §6.2, and §7 track those gaps and their mitigations.

## 9. Residual risks and open items

- **Per-redemption operator (T2)** is public until payout-note unbinding lands; until then
  community privacy degrades to the operator's tenancy.
- **Amount correlation (T3)** is open on both legs: entry `value` until issuance
  denominations land (planned); `redeemValue` until the redeem-side target (committed
  payout notes; fixed denominations as fallback) lands. Distinctive values
  bridge entry → operator → community until both close.
- **Expiration correlation (T5)** is open until quarter-bucketing lands; raw epochs narrow
  redemptions to a fine cohort.
- **Withdrawal timing (T4)** is behavioral until the in-circuit `count ≥ N` ∨ `age ≥ T`
  withdraw floor lands; even after, it is a *granularity floor* (a single-tenant batch still
  sums to one community) and aged low-volume withdraws stay small-batch — both fold into the
  low-tenancy residual. `N`, `T` open.
- **Redeem-event cadence is unavoidably public (F2).** `redeem` cannot be batched (double-
  spend protection), so the stream of redeem events and their timing is always visible;
  privacy then depends on each event carrying no operator/amount (committed payout notes),
  giving an anonymity set of *all* system redeems rather than per-operator. A committed but
  operator-named balance leaves this cadence attributable.
- **Entry value `V` is public** at purchase until denominations standardize it.
- **Low-tenancy operators** cannot be fully protected on-chain even after the above; this
  is an operator-set/economic property, not something the chain can fix.
- **The user↔pseudonym link** is outside the protocol; the protocol only guarantees the
  pseudonym is not linked to a community or to membership.
- **Proving-bound griefing/state growth (T6)** is open until the per-assign fee + dust
  floor land.
- **Off-chain read path (T8)** is addressed by design rather than by the on-chain layer: relays
  run a light client and serve clients' Merkle-path / scan reads over SimpleX onion routing
  ([simplexmq#1795](https://github.com/simplex-chat/simplexmq/pull/1795)), hiding the querier;
  query *content* to the relay is an accepted disclosure (§6.2). The residual is
  implementation-only — the PoC dapps still read the chain directly — and PIR / decoy reads
  remain optional for a stronger bar.

See `docs/gas-design.md` for the on-chain mechanics and measured costs, the
Community Credits whitepaper for the full privacy goals and the sketched
redemption-privacy closure, and the dust-floor and per-assign-fee issues for the
integrity/availability controls referenced above.

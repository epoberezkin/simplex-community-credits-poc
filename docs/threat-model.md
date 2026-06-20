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

**Assumptions:** SimpleX provides metadata-private membership/messaging; users apply
anonymization precautions to their on-chain pseudonym; circuits and the on-chain
Poseidon are byte-equal so proofs are sound; the chain and all events are public and
permanent.

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
  withdrawal, are public.
- **P6 — Operator transparency (a deliberate disclosure).** Operator identity and
  *aggregate* turnover are public at withdrawal; this is desired, not a leak. It does
  **not** extend to per-redemption operator linkage (that is hidden under P5).

Integrity / availability:

- **I1** No double-spend (nullifiers), **I2** no value creation / solvency holds,
  **I3** no theft or reroute of value, **I4** the service cannot be cheaply griefed into
  insolvency or state exhaustion.

**Meta-property (governing principle):** for every privacy property, the on-chain layer
must be *at least as strong* as SimpleX — it may not re-expose membership or community
attribution that the messaging layer hides.

## 6. Threats — what can leak on-chain

The community is cryptographically hidden in every operation, so the observer never sees
a community label. The residual risk is **reconstructing community-level attribution
from public metadata** — chiefly the operator, the amounts, and the expiration height.

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

**Explicitly *not* threats in this model:** a relay learning the community it serves
(off-chain, accepted); operator identity and *aggregate* turnover being public (P6,
desired). We do not spend effort hiding those.

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

## 7. Mitigations and requirements

Mapping threats to controls; "status" reflects the current PoC. The first three rows are
the privacy-hardening backlog that brings the PoC up to the whitepaper goals.

| Control                                                                 | Addresses        | Status                                                                                                 |
|-------------------------------------------------------------------------|------------------|--------------------------------------------------------------------------------------------------------|
| **Fixed issuance denominations** — mint vouchers (`value` at `buyAndCreate`) only in a small standard set, so the public entry amount is low-cardinality and the buy→redeem bridge faces a large anonymity set | T3 (entry), T1-bridge, T7 | **Planned** — [#6](https://github.com/epoberezkin/simplex-community-credits-poc/issues/6)              |
| **Hide the redemption amount** (`redeemValue`) — a community cashes out an *arbitrary accumulated* balance, so there is no single clean fix. *Options:* (a) fixed redemption denominations (redeem in standard chunks, remainder as change); (b) fold the amount into payout-note unbinding (committed, not cleartext); (c) AHE-aggregated per operator | T3 (redeem); P3/P5 | **Open — option space, not yet chosen** (fixed denominations is only *one* of these)                   |
| **Quarterly expiry bucketing** — client aligns each note's `expiryEpoch` to a coarse boundary (e.g. a quarter), so a wide range of purchases collapses to one published height | T5; P4/P5 | **Planned (client-side)** [#5](https://github.com/epoberezkin/simplex-community-credits-poc/issues/5)] |
| **Payout-note unbinding** — `redeem` produces a sealed payout note to a community/operator commitment + bearer fee to the includer instead of naming `operatorId`; the operator later withdraws its accumulated total proving only that it is registered. If the payout note's value is *committed* rather than public, this also hides `redeemValue` (= redeem-side option (b) above) | T2 (+ T3-redeem if value committed); P3/P5 (removes per-redemption operator) | **To be defined** — the whitepaper's "redemption-privacy gap" closure                                  |
| **Exit buffering** — accrue to `credit`, aggregate withdrawals on the operator's own schedule and on a delay; never 1:1 | T4; P5 | **Partial** — credit/withdraw exists; batching is behavioral, not enforced                             |
| **Operator multi-tenancy** (operators must mix many communities) — fallback for residual bucketing once the above land | T2 / P3 | **Required (deployment)** — single-tenant operators cannot be fully protected on-chain                 |
| Community as a **private** input (`redeemerHash`) in assign & redeem    | P1, P2, P3       | **Implemented**                                                                                        |
| Nullifier + ZK Merkle membership → spends unlinkable to commitments     | P4, I1           | **Implemented**                                                                                        |
| Solvency invariant, operator registry, epoch expiry/reclaim             | I2, I3           | **Implemented**                                                                                        |
| **Per-assign fee** (bearer, paid to the includer from note value)       | T6; enables permissionless/replaceable inclusion | **Planned** [#4](https://github.com/epoberezkin/simplex-community-credits-poc/issues/4)                |
| **Dust floor** (`destValue ≥ MIN`) — caps spam amplification & leaf use | T6 (capacity), T7| **Planned** [#3](https://github.com/epoberezkin/simplex-community-credits-poc/issues/3)                |
| User anonymization precautions for the pseudonym (out-of-protocol)      | T1               | **Assumed**                                                                                            |

Notes:

- **The amount channel has two independent legs.** *Issuance* (`value`) and *redemption*
  (`redeemValue`) are mitigated separately. Issuance denominations are planned and simple —
  the issuer mints standard sizes. Redemption is harder because a community cashes out an
  arbitrary accumulated balance; hiding `redeemValue` is an open choice among fixed
  redemption denominations, committed payout notes, or AHE. The two legs must *both* close
  for the buy→redeem amount bridge to be cut: denominated entry alone still leaks if
  `redeemValue` is a distinctive cleartext, and vice-versa.
- **Closing P3/P5 needs all the channels.** Entry + redeem amounts (above), expiry
  bucketing (T5), and per-redemption operator removal (T2, payout-note unbinding) must all
  land before an operator's public withdrawal becomes an *irreducible aggregate* that does
  not factor into per-community figures (P3/P5), matching the whitepaper.
- **Redemption-amount options compared.** Fixed redemption denominations make every
  `redeemValue` indistinguishable *unconditionally*, at the cost of more notes/leaves and
  the awkwardness of forcing an arbitrary balance into standard chunks. AHE keeps amounts
  encrypted while proving aggregate turnover, but relies on the operator batching before the
  aggregate is revealed (a size-one batch leaks the amount). Committed payout notes hide
  `redeemValue` as a by-product of the operator-unbinding mechanism (T2), so if that lands
  it may make a separate denomination scheme on the redeem leg unnecessary — which is why
  redemption denominations are recorded as *one option*, not the plan.
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
expiration heights (T5), per-redemption `operatorId` (T2), and immediate withdrawals
(T4) — that is a gap to close before the system can be said to meet the whitepaper goals
and to "not weaken" SimpleX. §6.1 and §7 track those gaps and their mitigations.

## 9. Residual risks and open items

- **Per-redemption operator (T2)** is public until payout-note unbinding lands; until then
  community privacy degrades to the operator's tenancy.
- **Amount correlation (T3)** is open on both legs: entry `value` until issuance
  denominations land (planned); `redeemValue` until a redeem-side option (fixed
  denominations, committed payout notes, or AHE) is chosen and lands. Distinctive values
  bridge entry → operator → community until both close.
- **Expiration correlation (T5)** is open until quarter-bucketing lands; raw epochs narrow
  redemptions to a fine cohort.
- **Withdrawal timing (T4)** depends on operator behavior until aggregation is enforced.
- **Entry value `V` is public** at purchase until denominations standardize it.
- **Low-tenancy operators** cannot be fully protected on-chain even after the above; this
  is an operator-set/economic property, not something the chain can fix.
- **The user↔pseudonym link** is outside the protocol; the protocol only guarantees the
  pseudonym is not linked to a community or to membership.
- **Proving-bound griefing/state growth (T6)** is open until the per-assign fee + dust
  floor land.

See `docs/gas-design.md` for the on-chain mechanics and measured costs, the
Community Credits whitepaper for the full privacy goals and the sketched
redemption-privacy closure, and the dust-floor and per-assign-fee issues for the
integrity/availability controls referenced above.

# Threat Model — Community Credits

## 1. Purpose, scope, and the governing principle

Community Credits is a payment layer for **paywalled SimpleX communities**: users buy
stablecoin-backed vouchers and assign them to communities to subscribe; communities
redeem them with relay operators to cash out. This document states *what must stay
hidden, from whom, and why*, and which on-chain facts are deliberately public.

**Governing principle — do not weaken SimpleX.** SimpleX (simplexmq) already provides
metadata-private messaging and membership: who belongs to a community, who talks to
whom, and the social graph are not exposed. The credits layer is an *add-on*. Its
binding requirement is that **it must not introduce any deanonymization channel that
SimpleX otherwise prevents.** Concretely: nothing on-chain may let an observer learn a
community's membership or attribute on-chain activity to a specific community. The
payment must be held to the same metadata-privacy bar as the messaging.

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
*private* circuit input in both assign and redeem and **never appears on-chain**.

| Operation      | Signed/submitted by      | Public on-chain                                                        | Hidden (ZK / private)                                                                |
|----------------|--------------------------|------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `buyAndCreate` | buyer pseudonym          | buyer address, `value`, `expiryEpoch`, commitment, leaf index          | — (this is the entry point; `value` and `time` are public)                         |
| `assign`       | a relay (fee-market)     | nullifier, `expiryEpoch`, two output commitments, root, fee `F`        | dest community, the dest/change split, *which* note was spent, member↔community link |
| `redeem`       | an operator              | nullifier, `expiryEpoch`, `redeemValue`, change commitment, `operatorId`| the community, *which* note was spent                                                |
| `withdraw`     | an operator              | operator address, `amount`                                             | — (operator identity and turnover are intentionally public)                          |

The user's pseudonym appears **only at `buyAndCreate`**; `assign` is relayed and
community-blind, so a member never signs an on-chain action that names their community.
The nullifier + ZK membership proof make each spend unlinkable to the commitment it
consumes, so `buy → assign → redeem` cannot be chained on-chain by anything other than
amount/timing correlation.

## 3. Stakeholders: interests, anonymity, and disclosure

| Stakeholder         | Core interest                                                   | What "anonymity" means for them                          | Must stay hidden                                                                 | May / should be public                                             |
|---------------------|-----------------------------------------------------------------|----------------------------------------------------------|----------------------------------------------------------------------------------|--------------------------------------------------------------------|
| **User / member**   | Subscribe to a paywalled community without exposing it          | Their **membership is unlinkable** — to anyone           | Which community they belong to / pay into; any link from their pseudonym to a community or to other members | Their pseudonymous buy address, and that *some* address bought value `V` |
| **Community admin** | Run a paywalled community, collect payments, cash out, get tiered relay service | The **community is unattributable on-chain**             | The community's identity to the public; any per-community decomposition of on-chain activity; the member roster | The community's identity **to its own relay operator(s)**, off-chain, to access tiered service |
| **Relay operator**  | Run a transparent, accountable cash-out/relay service, earn fees | **Customer-set privacy** (they are not themselves anonymous) | **Which communities it serves** — leaking this exposes those communities to scrutiny/censorship and exposes the relay to coercion | Its identity and its **aggregate turnover/throughput** — public *by design*, for transparency |

### 3.1 Users (members / subscribers)

Users buy vouchers to subscribe to paywalled communities. Their interest is access,
not exposure. **Anonymity = their community membership is hidden from everyone** —
relay operators, other members, and the public. The sensitive fact is the *association*
(this pseudonym → this community), not the payment itself. Users accept that a
pseudonymous address is visible at purchase; they do not accept that this pseudonym can
be connected to a community. Co-member anonymity is included: one member must not be
able to enumerate or identify the others.

### 3.2 Community admins

A community is willing to be **known to its relay operator(s)** — that relationship is
useful and intended, because operators offer tiered service to known communities. What
the admin needs is that the community stays **anonymous to the public and to on-chain
observers**, and in particular that the operator's (public) activity cannot be
*decomposed* into per-community figures. Being a known customer of an operator is fine;
having your community's redemption history readable off the chain is not.

### 3.3 Relay operators

Operators are **publicly known and want their aggregate turnover public** — this is a
feature: transparent, auditable throughput builds trust and accountability. Their
privacy interest is narrow and specific: **do not reveal which communities they serve.**
A leaked customer list exposes those communities to targeting/censorship and makes the
operator a coercion point. Note this interest is *aligned* with the communities' and
users' interests — all three reduce to the same on-chain property below.

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

Privacy:

- **P1 — Membership privacy.** No party (operator, co-member, public) can link a user
  pseudonym to a community.
- **P2 — Community anonymity (public).** No on-chain observer can identify a community.
  (Known to its own operator off-chain is permitted.)
- **P3 — No per-community attribution.** An operator's accepted-public turnover must not
  *decompose* into per-community amounts, counts, or timing.
- **P4 — Flow unlinkability.** `buy → assign → redeem` cannot be chained on-chain.
- **P5 — Operator transparency (a deliberate disclosure).** Operator identity and
  aggregate turnover are public; this is desired, not a leak.

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
from the public metadata** — chiefly the operator and the amounts.

- **T1 — Pseudonym at entry.** `buyAndCreate` exposes a buyer pseudonym + `value`.
  *Accepted and bounded*: it must reveal only "an address bought `V`," never a community
  (P1). The danger is only if amount/timing later bridge it to a community (see T3).
- **T2 — Operator bucketing.** `operatorId` on `redeem` (and the matching
  `credit`/`withdraw`) buckets every redemption under a public operator. This is fine as
  *aggregate* turnover (P5) **but breaks P3 when operator tenancy is low** — a
  single-tenant operator's public turnover *is* one community's, decomposition for free.
- **T3 — Public amounts.** `value`, `redeemValue`, and `withdraw amount` are public.
  Distinctive amounts (a) fingerprint individual redemptions inside an operator's pile,
  (b) chain a public buyer's deposit to an operator's redemption across the ZK boundary
  by value + time (re-linking T1 → a community), and (c) let an operator's turnover be
  decomposed by amount. **Primary threat to P1 and P3.**
- **T4 — Exit timing.** An operator that withdraws immediately / 1:1 after a redemption
  links its real-money settlement to that specific redemption, sharpening T2/T3 on the
  cash-out leg.
- **T5 — Paymaster griefing / state exhaustion (I4).** `assign` is relay-sponsored,
  unprofitable, and opaque, so an attacker can spam tiny assigns to drain a relay's gas
  and consume the shared Merkle tree's leaves, limited only by proving effort.
- **T6 — Dusting / tainting.** Uniquely-valued micro-notes used to fingerprint and trail
  a user/community.

**Explicitly *not* threats in this model:** a relay learning the community it serves
(off-chain, accepted); operator identity and aggregate turnover being public (P5,
desired). We do not spend effort hiding those.

## 7. Mitigations and requirements

Mapping threats to controls; "status" reflects the current PoC.

| Control                                                                 | Addresses        | Status                          |
|-------------------------------------------------------------------------|------------------|---------------------------------|
| Community as a **private** input (`redeemerHash`) in assign & redeem    | P1, P2, P3       | **Implemented**                 |
| Nullifier + ZK Merkle membership → spends unlinkable to commitments     | P4, I1           | **Implemented**                 |
| Solvency invariant, operator registry, epoch expiry/reclaim             | I2, I3           | **Implemented**                 |
| **Operator multi-tenancy** (operators must mix many communities)        | T2 / P3          | **Required (deployment)** — single-tenant operators cannot be protected on-chain |
| **Fixed denominations** (standardize `value`/`redeemValue`/`withdraw`)  | T3, T4-amount, T6, T1-bridge | **Required (design gap)** — currently amounts are arbitrary and public |
| **Exit buffering** — accrue to `credit`, aggregate withdrawals, no 1:1  | T4               | **Partial** — credit/withdraw exists; batching is currently behavioral, not enforced |
| **Per-assign fee** (bearer, paid to the includer from note value)       | T5; enables permissionless/replaceable inclusion; (extended to redeem) optional `operatorId` unbinding | **Planned** (see fee issue) |
| **Dust floor** (`destValue ≥ MIN`) — caps spam amplification & leaf use | T5 (capacity), T6| **Planned** (see dust-floor issue) |
| User anonymization precautions for the pseudonym (out-of-protocol)      | T1               | **Assumed**                     |

Notes:

- **Multi-tenancy + denominations are the core of community privacy** under the accepted
  operator disclosure. Tenancy closes the operator-bucketed count/timing channel;
  denominations close the amount channel. Neither alone suffices; together, the
  operator's public turnover is an *irreducible aggregate* that does not factor into
  per-community figures (P3), and the buyer↔operator amount bridge (T1→community) is cut.
- **Fixed denominations vs AHE.** Additively-homomorphic encryption could keep
  per-redemption amounts encrypted while still proving aggregate turnover, but it relies
  on the operator batching before the aggregate is revealed (a size-one batch leaks the
  amount). Fixed denominations make every amount indistinguishable *unconditionally*, so
  they are the more robust choice for T3; their cost is more notes/leaves.
- **`operatorId` unbinding** (redeem to a community-controlled commitment + a bearer fee
  to the includer) is *not required* once operators are multi-tenant — `operatorId` then
  just shows accepted operator activity. It is useful **defense-in-depth for the
  low-tenancy tail**, where it removes the bucket key entirely.

## 8. Relationship to SimpleX (the non-weakening invariant)

SimpleX hides community membership and the social graph at the messaging layer. The
credits layer adds money, which is the classic place metadata privacy is lost. The
invariant is that **a community's membership and attribution must remain as hidden
on-chain as they are in SimpleX**:

- Membership that SimpleX hides (which user is in which community) must not be
  reconstructable from the chain (P1) — i.e. the pseudonym↔community link stays broken.
- A community SimpleX keeps unlinkable must stay unattributable on-chain (P2, P3).
- The credits layer may *reveal* only what is intentionally public (operator identity +
  turnover) and what is inherent at the entry point (a pseudonymous deposit of `V`).

Wherever a credits-layer disclosure would be strictly more revealing than SimpleX
(today: arbitrary public amounts, low-tenancy operator bucketing, immediate withdrawals),
that is a gap to close before the system can be said to "not weaken" SimpleX.

## 9. Residual risks and open items

- **Low-tenancy operators** cannot be protected on-chain; community privacy degrades to
  the operator's tenancy. This is an operator-set/economic property, not something the
  chain can fix.
- **Amount correlation** (T3) is open until denominations land; until then distinctive
  values can bridge entry → operator → community.
- **Withdrawal timing** (T4) depends on operator behavior until aggregation is enforced.
- **Entry value `V` is public** at purchase until denominations standardize it.
- **The user↔pseudonym link** is outside the protocol; the protocol only guarantees the
  pseudonym is not linked to a community or to membership.
- **Proving-bound griefing/state growth** (T5) is open until the per-assign fee + dust
  floor land.

See `docs/gas-design.md` for the on-chain mechanics and measured costs, and the dust-floor
and per-assign-fee issues for the integrity/availability controls referenced above.

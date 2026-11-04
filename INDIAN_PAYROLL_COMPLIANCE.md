# Indian payroll & labour compliance — verification register

> **No statutory rule in this register has been verified, and payroll is not implemented.** This register lists what must be verified, with what evidence and by whom, before any statutory calculation is built or activated. No rates, thresholds or ceilings are stated here on purpose: they change, they depend on applicability, and they must come from the official source at the time of verification. Do not copy figures into code from memory or secondary sources.

## How rules will be used

- Each verified rule becomes a row in a future `statutory_rules` table: rule id, jurisdiction, applicability criteria, formula/threshold/rate, effective from/to, official source URL, verification date, reviewer, approval status.
- The payroll engine will only use rules in `approved` status, effective on the payroll period date. Each payroll run will snapshot the rule versions it used. Finalized payroll is never recalculated silently after a rule change.
- Activating a changed rule in production requires an authorized reviewer (maker-checker), recorded in the audit log.
- The platform must never claim a return was filed or a registration completed unless an authorized integration confirms it.

## Register

Columns: **Req** requirement · **Jurisdiction** · **Applicability assumptions** to confirm · **Official source** (to be filled with the exact page used at verification) · **Verified on / by** · **Status**

| # | Requirement | Jurisdiction | Applicability to confirm | Official source (starting point) | Verified on / by | Status |
|---|---|---|---|---|---|---|
| C1 | EPF & allied schemes: contribution bases, wage ceiling, employer/employee shares, admin charges, ECR format | Central | Establishment coverage; wage definition; voluntary higher contribution | EPFO — https://www.epfindia.gov.in | — | Not verified |
| C2 | ESI: wage threshold, contribution rates, contribution periods, coverage areas | Central (area-notified) | Branch locations' coverage; employee wage band | ESIC — https://www.esic.gov.in | — | Not verified |
| C3 | Professional tax: slabs, frequency, exemptions | State-wise (e.g. Maharashtra, Karnataka) | States of each branch | Each state's commercial-tax/PT department | — | Not verified |
| C4 | Labour welfare fund: amounts, periodicity | State-wise | States of each branch; employee categories | Each state's labour welfare board | — | Not verified |
| C5 | Income-tax TDS on salary (s.192): regimes, slabs, standard deduction, rebate, cess, declarations; Form 16; quarterly 24Q | Central | Regime choice per employee; financial year | Income Tax Department — https://www.incometax.gov.in | — | Not verified |
| C6 | Gratuity: eligibility, formula, ceiling | Central | Establishment coverage | Ministry of Labour & Employment — https://labour.gov.in | — | Not verified |
| C7 | Statutory bonus: eligibility, minimum/maximum, wage ceiling, set-on/set-off | Central | Establishment coverage; allocable surplus | Ministry of Labour & Employment | — | Not verified |
| C8 | Maternity benefit: entitlement, eligibility, payment | Central | All establishments in scope | Ministry of Labour & Employment | — | Not verified |
| C9 | Minimum wages: scheduled-employment rates incl. VDA, by zone and skill | State-wise (and central sphere) | Lab roles' classification per state | State labour departments | — | Not verified |
| C10 | Overtime: rate and hours limits; working hours; weekly rest; spread-over | State shops & establishments acts / Factories Act as applicable | Which act applies to each lab/branch | State labour departments | — | Not verified |
| C11 | Leave entitlements (earned/casual/sick) minimums | State S&E acts | Per branch state | State labour departments | — | Not verified |
| C12 | Wage payment timing and permitted deductions | Central/State | Wage period; establishment type | Ministry of Labour & Employment | — | Not verified |
| C13 | Labour Codes (Wages; Industrial Relations; Social Security; OSH) and their rules: commencement status and changes to wage definitions | Central + State rules | Commencement and notified rules at verification time | Ministry of Labour & Employment; Gazette of India — https://egazette.gov.in | — | Not verified |
| C14 | Digital Personal Data Protection Act 2023 and rules: commencement, notices, consent, retention, data-principal rights | Central | Notified rules and effective dates at verification time | MeitY — https://www.meity.gov.in | — | Not verified |
| C15 | GST on reimbursements / input tax credit treatment | Central/State | Finance policy | GST portal / CBIC — https://cbic-gst.gov.in | — | Not verified |

## Treatments in code that a qualified reviewer must confirm

These are the engine's legal treatments, not rates. They are the mainstream reading, chosen so the engine has a defined behaviour (`DECISIONS.md` D25 onward). They are not legal advice and have not been reviewed.

- **ESI (C2):** contribution periods April to September and October to March; cover fixed by the full-month wage at the period start. A qualified reviewer must confirm this.
- **TDS (C5):** taxable one-offs add their extra annual tax in the month paid; regular salary spreads over 12 months with no YTD true-up, declarations or marginal relief. A qualified reviewer must confirm this.

## Process to verify an item

1. A qualified Indian payroll or legal reviewer reads the official source and records the exact URL, notification number and effective date.
2. Record applicability assumptions for each tenant (establishment type, states, headcount).
3. Enter the rule, then a second reviewer approves it (maker-checker).
4. Add regression test cases with worked examples from the source.
5. Re-verify on every budget, notification or rule change, and at least quarterly.

# Changelog

## Unreleased

### Removed

* `JOBS_ENABLED`: replaced by `PROCESS_ROLE=api|worker`. Only the worker runs the scheduler and sends email.

### Changed

* `POST /api/v1/tenant/jobs/:key/run` answers 202 with `{ runId, status: "queued" }`; the worker runs it.

## [1.1.0](https://github.com/rgrishabh/hrms-backend/compare/v1.0.0...v1.1.0) (2026-11-04)


### Features

* **accounting:** payroll and reimbursement journals as CSV or Tally XML ([#24](https://github.com/rgrishabh/hrms-backend/issues/24)) ([5f78797](https://github.com/rgrishabh/hrms-backend/commit/5f78797ea5ac3b7aa163c013003fcdfcdae1eb99))
* add /health and /ready endpoint aliases ([4d54193](https://github.com/rgrishabh/hrms-backend/commit/4d54193114278a2e92d23c9962345ef334dbf472))
* **api:** HRMS API with attendance, leave, documents, MFA, expenses, competency and policies ([f4d53da](https://github.com/rgrishabh/hrms-backend/commit/f4d53da9c8517077e3e3706ba37f8f6a58903348))
* **approvals:** delegation while away and time-based escalation ([#29](https://github.com/rgrishabh/hrms-backend/issues/29)) ([b1a0008](https://github.com/rgrishabh/hrms-backend/commit/b1a000850415170594e2d5e6eb86f1c3fffd5d54))
* **attendance:** rotating shift rosters with staggered crews and one-day overrides ([#31](https://github.com/rgrishabh/hrms-backend/issues/31)) ([edee8d6](https://github.com/rgrishabh/hrms-backend/commit/edee8d65f97c581d23e06f4ea0c20a1c8871a0a6))
* **auth:** Hiring Approver role for management sign-off on hiring ([1135d99](https://github.com/rgrishabh/hrms-backend/commit/1135d991aefe448d6dfdc90e64534ea5e118c70a))
* **cases:** people lookup for IC membership and handler assignment ([5bb4067](https://github.com/rgrishabh/hrms-backend/commit/5bb40677684047e33c24c83f86a194ce94c4fbb9))
* **cases:** POSH complaints for the Internal Committee and grievances, encrypted, with timelines ([13150d7](https://github.com/rgrishabh/hrms-backend/commit/13150d7614167296d096ed555c830eeee7911045))
* **dashboard:** role-aware dashboard summary; clock-in card shows only today ([710a2de](https://github.com/rgrishabh/hrms-backend/commit/710a2defde5fe1fe5feac9926dd91381c9810115))
* **db:** synthetic demo-data generator for empty dev installations ([e1b509b](https://github.com/rgrishabh/hrms-backend/commit/e1b509b565d4a1cf092e037e920951b81e39fcb8))
* **employees:** personal details — emergency contacts, addresses, nominees, education, previous employment ([#28](https://github.com/rgrishabh/hrms-backend/issues/28)) ([485136e](https://github.com/rgrishabh/hrms-backend/commit/485136ea5b8745fe9180c5cb62846a8c0e2044b1))
* **expenses:** per-diem and mileage allowances from effective-dated policy rates ([#32](https://github.com/rgrishabh/hrms-backend/issues/32)) ([4466e87](https://github.com/rgrishabh/hrms-backend/commit/4466e87a23d76f1decf13609c9ea8fcd12dbec9b))
* **field-duty:** field duty requests counted as paid on-duty days in attendance ([e1b6780](https://github.com/rgrishabh/hrms-backend/commit/e1b67804c3d9f795b65fa9a772f577dca271f206))
* **lifecycle:** onboarding/exit checklists, probation reviews, separations with clearance and access end ([ea1139d](https://github.com/rgrishabh/hrms-backend/commit/ea1139db11e33bcac63fb5c61ee085ee8a3869dd))
* **loans:** salary advances and interest-free loans recovered through payroll ([#23](https://github.com/rgrishabh/hrms-backend/issues/23)) ([f2fe3bc](https://github.com/rgrishabh/hrms-backend/commit/f2fe3bc63e3edef79e228bd2edfcb6240dc469fd))
* **overtime:** overtime claims paid through payroll or taken as compensatory off ([9d5a7bd](https://github.com/rgrishabh/hrms-backend/commit/9d5a7bdc32e564719cdb34f0fe49871de30d15d3))
* **payroll:** components, approved salaries, verified statutory rules, runs with LOP, approval, finalize lock, payslips, exports, F&F ([507740a](https://github.com/rgrishabh/hrms-backend/commit/507740a33d6cbef9fb99b5d3e3e660153c0fbf6e))
* **performance,assets:** review cycles, goals and reviews; asset register with issue/return, calibration and exit check ([8161935](https://github.com/rgrishabh/hrms-backend/commit/81619359a72199a7bcaf2a9cb31d26d32eb0baa3))
* **recruitment:** panel user lookup for scheduling interviews ([594cb9c](https://github.com/rgrishabh/hrms-backend/commit/594cb9cbd1cc77c642722081c6c8724a9879fd53))
* **recruitment:** requisitions, candidates with consent and retention, interview pipeline, approved offers and hire ([ad42afb](https://github.com/rgrishabh/hrms-backend/commit/ad42afb7974d68fa4dbd2dedbfdf081afb7c4989))
* **reports:** Excel (.xlsx) export for reports, payroll register and policy acknowledgements ([#33](https://github.com/rgrishabh/hrms-backend/issues/33)) ([207a1e8](https://github.com/rgrishabh/hrms-backend/commit/207a1e85c321cfc869fe935bad7da9c046e8333c))
* **reports:** reports module with CSV export ([67c86fa](https://github.com/rgrishabh/hrms-backend/commit/67c86fa9cdb0b0b35fddf7b3fcb955edb9581de9))
* **reports:** saved and scheduled reports; department overview ([#26](https://github.com/rgrishabh/hrms-backend/issues/26)) ([a27d255](https://github.com/rgrishabh/hrms-backend/commit/a27d25557d52e3566f744ef946ad50140c72f491))
* **roles:** organizations define their own roles; MFA follows permissions ([#30](https://github.com/rgrishabh/hrms-backend/issues/30)) ([280ca43](https://github.com/rgrishabh/hrms-backend/commit/280ca439ddc0274e8152788988e4a14ff2d35d7d))
* **sms:** SMS notifications through the organization's provider with DLT templates ([#25](https://github.com/rgrishabh/hrms-backend/issues/25)) ([0dfc7bf](https://github.com/rgrishabh/hrms-backend/commit/0dfc7bf37231100ecc6a43a94e8f210978a3c8e8))
* **travel:** trip requests with estimates and advances, settled against the trip's claim ([b0376dd](https://github.com/rgrishabh/hrms-backend/commit/b0376dd59ac679a85c8133aad2d971c5657426f1))


### Bug Fixes

* **api:** configurable global rate limit, default 3000/min per IP ([3bcf8f0](https://github.com/rgrishabh/hrms-backend/commit/3bcf8f0166f67e008a6f356f5685d9bbc9814a60))
* **demo:** count only the leave requests actually recorded ([749d78b](https://github.com/rgrishabh/hrms-backend/commit/749d78b792b25415db9d458b7e35178a65ca5fe1))
* **docker:** apk upgrade in the runtime image ([fb6dfb6](https://github.com/rgrishabh/hrms-backend/commit/fb6dfb67c4da25649d1796aaca74e3f42e223f8e))
* **docker:** drop npm, npx, corepack and yarn from the runtime image ([d498741](https://github.com/rgrishabh/hrms-backend/commit/d49874188a02c02ef66356ca7b6c1bc91a39c3d6))
* **features:** every route of a switched-off module is refused ([56204c7](https://github.com/rgrishabh/hrms-backend/commit/56204c7ec23879a52e51f0763f3ac2bb037414b1))
* ignore only the top-level storage/ directory, not src/core/storage ([3a6b647](https://github.com/rgrishabh/hrms-backend/commit/3a6b6471f15c1ac08100f65cf9f33397269383a7))
* **security:** segregation of duties and confidentiality hardening ([8af5b74](https://github.com/rgrishabh/hrms-backend/commit/8af5b74eafce9a9b16ee1dafc9111d2b9aa0428b))
* **security:** user management cannot escalate privileges ([12f0c1a](https://github.com/rgrishabh/hrms-backend/commit/12f0c1a8af42b0b8aab6e78fbaf9309d39797995))
* send 201 responses after the transaction commits ([afa1ca3](https://github.com/rgrishabh/hrms-backend/commit/afa1ca36467ca02b56dcf7ca6387421c161f9100))
* stay ready on a newer schema so a release can be rolled back ([38ba57b](https://github.com/rgrishabh/hrms-backend/commit/38ba57b3da57a5470692284235313d2b3bd9e710))
* the clock-in card listed yesterday evening's punches as today's. ([710a2de](https://github.com/rgrishabh/hrms-backend/commit/710a2defde5fe1fe5feac9926dd91381c9810115))

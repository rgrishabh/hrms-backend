# Employee record: personal details

The core record (name, organization, employment dates, reporting line), bank details and statutory IDs are covered in
the employees and payroll guides. This guide covers the personal sections: **emergency contacts, addresses, nominees,
education and previous employment**. They are part of the always-on employee module.

## Who sees and changes what

| | Sees | Changes directly | Changes through HR approval |
|---|---|---|---|
| The employee (`profile.self`) | Their own sections | Emergency contacts, addresses | Nominees, education, previous employment |
| HR (`employees.manage`) | Everyone's | Every section of other employees | Their own nominees, education and history, like any employee |
| Full employee readers (`employees.read`, e.g. payroll, auditors) | Everyone's | — | — |
| Managers, colleagues | Nothing (personal details are not part of the directory or the team view) | — | — |

A change that needs approval goes to anyone with `profile.approve` (HR Administrator, HR Executive), never to the
employee it concerns. The approver can open the change next to the section as it is now
(`GET /employees/profile-changes/:id`). It applies when approved. An employee has at most one pending change per
section, and can withdraw it while it is pending.

## Rules

- **Each section is replaced as a whole.** The order of emergency contacts is the order to call them in.
- **Emergency contacts:** up to 5; a phone number is required.
- **Addresses:** one current and one permanent. An address in India needs a 6-digit PIN code.
- **Nominees:** per purpose (provident fund, gratuity, insurance, other), the shares add up to 100%. A nominee under 18
  needs a guardian. A change is checked again when it is approved, so a nominee who came of age, or a corrected joining
  date, is taken into account.
- **Previous employment** ends on or before the date of joining.
- **Missing details:** the profile lists what is missing (an emergency contact, either address, and a PF nominee when
  statutory payroll is in use). HR has the report **Reports → People → Missing personal details**, which also shows
  changes awaiting approval.

## Privacy

The audit log records which section changed, how many entries it has, and who changed it. It never records the
contents (names, phone numbers, addresses). Whether a nominee arrangement satisfies a particular scheme's form (for
example EPF Form 2) is for the organization to check. The record holds the employee's declaration, not a filed form.

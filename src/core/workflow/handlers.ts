import { registerAttendanceApprovals } from '../../modules/attendance/routes.js';
import { registerCompetencyApprovals } from '../../modules/competency/routes.js';
import { registerEmployeeApprovals } from '../../modules/employees/routes.js';
import { registerExpenseApprovals } from '../../modules/expenses/routes.js';
import { registerFieldDutyApprovals } from '../../modules/field-duty/routes.js';
import { registerLeaveApprovals } from '../../modules/leave/routes.js';
import { registerLifecycleApprovals } from '../../modules/lifecycle/routes.js';
import { registerLoanApprovals } from '../../modules/loans/routes.js';
import { registerOvertimeApprovals } from '../../modules/overtime/routes.js';
import { registerPayrollApprovals } from '../../modules/payroll/routes.js';
import { registerProfileApprovals } from '../../modules/employees/profile.js';
import { registerRecruitmentApprovals } from '../../modules/recruitment/routes.js';
import { registerTravelApprovals } from '../../modules/travel/routes.js';

/**
 * Every approval handler, registered at startup in the API and the worker alike. They are independent of route
 * registration, so a request of a module whose routes are absent still has a handler when the module comes back.
 */
export function registerAllApprovalHandlers() {
  registerAttendanceApprovals();
  registerCompetencyApprovals();
  registerEmployeeApprovals();
  registerExpenseApprovals();
  registerFieldDutyApprovals();
  registerLeaveApprovals();
  registerLifecycleApprovals();
  registerLoanApprovals();
  registerOvertimeApprovals();
  registerPayrollApprovals();
  registerProfileApprovals();
  registerRecruitmentApprovals();
  registerTravelApprovals();
}

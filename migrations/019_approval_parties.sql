-- 019: maker-checker beyond the requester.
--  * approval_requests.excluded_user_ids: people who must never act on the request although they are not
--    its requester (the author of a drafted offer, the employee whose salary or leave it is).
--  * The engine also refuses a user acting on a second step of the same request (two approvals = two people).
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS excluded_user_ids uuid[] NOT NULL DEFAULT '{}';

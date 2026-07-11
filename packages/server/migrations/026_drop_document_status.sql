-- Remove the document status field. The `status` lifecycle flag
-- ('planning'/'approved') added in 015 proved redundant: real sign-off happens
-- through ticket comments (@admin approval), not this field, so it was metadata
-- agents and humans had to maintain for no payoff. Drop the column and its enum
-- type. All other document data (content, revisions, archival) is untouched.
ALTER TABLE documents DROP COLUMN IF EXISTS status;

DROP TYPE IF EXISTS document_status;

-- Built-in skills.
--
-- Some skills are shipped by Hezo itself (e.g. the seeded `find-skills`
-- discovery skill, whose body is inlined into every run's system prompt). They
-- are upserted by the startup reconcile (`seedBuiltins`) and marked here so the
-- admin UI can label them and block deletion, and so the reconcile can re-own a
-- row that was edited or removed. Agent- and admin-authored skills keep the
-- default `false`.
ALTER TABLE skills ADD COLUMN is_builtin BOOLEAN NOT NULL DEFAULT false;

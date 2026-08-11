-- Assets join the global full-text search, mirroring the generated-tsvector
-- pattern tasks / documents / task_comments / skills already use in 001.
--
--   search_text  Extracted UTF-8 text of a TEXTUAL asset (text/*, image/svg+xml);
--                NULL for a binary one, which is searchable by filename only.
--                It cannot be derived in SQL: asset bytes live in the AssetStore
--                (src/assets/store.ts), not the database, so no generated column
--                and no migration can reach them. It is written at asset-write
--                time via InsertAssetInput.searchText (lib/asset-name.ts), by
--                lib/asset-search-text.ts. Rows predating this migration keep
--                NULL and stay findable by filename until next saved.
--
--   search_tsv   Weight A over the filename, weight B over that extracted text.
--
-- The filename is deliberately indexed TWICE, raw and normalized. Postgres'
-- default parser classifies `launch/hero-image.png` as a single `file` token and
-- emits it as ONE lexeme, so `hero`, `image` and `png` would none of them match
-- it - the same tokenization trap services/search.ts already works around for a
-- task identifier like `HM-169`. The regexp copy splits every folder segment,
-- word and extension into its own lexeme. The raw copy is kept because the
-- ASCII-only class would otherwise destroy non-ASCII names (`résumé-final.pdf`
-- normalizes to `r sum final pdf`), and raw tokenization handles those correctly.
-- Together they cover both; extra lexemes can only add matches, never remove one.
--
-- `left(...)` restates the extractor's cap where no writer can bypass it. Because
-- search_tsv is GENERATED, an oversized input is not a bad search result - it is
-- a FAILED asset write (tsvector rejects a lexeme over 2 KB or a vector over
-- 1 MB), so the ceiling belongs in the database as well as in the extractor.
--
-- Two separate ALTERs: the generation expression must be parsed against a tuple
-- descriptor that already has search_text. Both run in the one transaction the
-- migration runner wraps the file in.

ALTER TABLE assets ADD COLUMN search_text TEXT;

ALTER TABLE assets ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    setweight(
        to_tsvector('english',
            coalesce(original_filename, '') || ' ' ||
            regexp_replace(coalesce(original_filename, ''), '[^A-Za-z0-9]+', ' ', 'g')
        ),
        'A'
    ) ||
    setweight(to_tsvector('english', left(coalesce(search_text, ''), 200000)), 'B')
) STORED;

CREATE INDEX idx_assets_search_tsv ON assets USING gin (search_tsv);

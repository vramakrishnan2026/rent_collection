-- Details read off ID cards: ID type and address (never the ID number or date of birth).
ALTER TABLE people ADD COLUMN address TEXT;
ALTER TABLE id_uploads ADD COLUMN id_type TEXT;
ALTER TABLE id_uploads ADD COLUMN address TEXT;

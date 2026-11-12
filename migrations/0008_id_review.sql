-- An ID photo for someone who already has one on file: both are kept, and the new one waits
-- for the owner to review ("Use this one" or "Keep current").
ALTER TABLE id_uploads ADD COLUMN review_person_id TEXT;

-- Second photo per person: the back of the ID (Aadhaar, DL and Voter ID have details on both sides).
ALTER TABLE people ADD COLUMN back_file_id TEXT;
ALTER TABLE people ADD COLUMN back_file_name TEXT;

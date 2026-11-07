CREATE TABLE IF NOT EXISTS pack_pieces (pack TEXT NOT NULL, version TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (pack, version, idx));

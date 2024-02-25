package infrastructure

// generic relational database
type (
	Database interface {
		// TODO implement Begin() for database transactions
		// TODO implement CollectRows, ForEachRow etc from pgx (these are more efficient helpers for reading ops)
		// TODO implement Copy helpers (for faster write ops)
		Open(postgresDSN, schema string)
		Close()
		Exec(sql string, args ...any) error
		Query(sql string, args ...any) (Rows, error)
		QueryRow(sql string, args ...any) Row
	}

	// helper interfaces for Database interface
	Rows interface {
		Close()
		Err() error
		Next() bool
		Scan(dest ...any) error
		Values() ([]any, error)
		RawValues() [][]byte
	}
	Row interface {
		Scan(dest ...any) error
	}
)

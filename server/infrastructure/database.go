package infrastructure

import "time"

// TODO implement Begin() for database transactions
// TODO implement CollectRows, ForEachRow etc from pgx (these are more efficient helpers for reading ops)
// TODO implement Copy helpers (for faster write ops)

// generic relational database
type Database interface {
	Open(postgresDSN string)
	Close()
	Exec(sql string, args ...any) error
	Query(sql string, args ...any) (Rows, error)
	QueryRow(sql string, args ...any) Row
}

// helper interfaces for Database interface
type Rows interface {
	Close()
	Err() error
	Next() bool
	Scan(dest ...any) error
	Values() ([]any, error)
	RawValues() [][]byte
}
type Row interface {
	Scan(dest ...any) error
}

// generic key value store
type Store interface {
	Open(addr string)
	Close()
	Get(key string) ([]byte, error)
	Set(key string, val []byte, exp time.Duration) error
	Delete(key string) error
	Reset() error
	Keys() ([][]byte, error)
}

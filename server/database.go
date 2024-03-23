package main

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

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

type PostgresDB struct {
	Conn            *pgxpool.Pool
	syncOnConnected *sync.WaitGroup
}

func NewDatabaseConnection(syncOnConnected *sync.WaitGroup) Database {
	syncOnConnected.Add(1)
	return &PostgresDB{
		syncOnConnected: syncOnConnected,
	}
}

func (db *PostgresDB) Open(postgresDSN, schema string) {
	var err error
	db.Conn, err = pgxpool.New(context.Background(), postgresDSN)
	if err != nil {
		log.Fatalf("Unable to create connection pool: %v\n", err)
	}

	err = db.Exec(fmt.Sprintf("SET search_path = '%s'", schema))
	if err == nil {
		db.syncOnConnected.Done()
	} else {
		log.Fatalf("Failed to establish database connection with required schema: %v\n", err)
	}
}

func (db *PostgresDB) Close() {
	db.Conn.Close()
}

func (db *PostgresDB) Exec(sql string, args ...any) error {
	_, err := db.Conn.Exec(context.Background(), sql, args...)
	return err
}

func (db *PostgresDB) Query(sql string, args ...any) (Rows, error) {
	return db.Conn.Query(context.Background(), sql, args...)
}

func (db *PostgresDB) QueryRow(sql string, args ...any) Row {
	return db.Conn.QueryRow(context.Background(), sql, args...)
}

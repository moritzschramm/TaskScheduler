package infrastructure

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
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

package infrastructure

import (
	"context"
	"log"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

func NewDatabaseConnection() Database {
	return new(PostgresDB)
}

type PostgresDB struct {
	Conn *pgxpool.Pool
}

func (db *PostgresDB) Open(postgresDSN string) {
	var err error
	db.Conn, err = pgxpool.New(context.Background(), postgresDSN)
	if err != nil {
		log.Fatalf("Unable to create connection pool: %v\n", err)
		os.Exit(1)
	} else {
		log.Println("Database connection setup")
	}

	err = db.Conn.Ping(context.Background())
	if err == nil {
		log.Printf("Database connection established with %v\n", postgresDSN)
	} else {
		log.Fatalf("Failed to establish database connection: %v\n", err)
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

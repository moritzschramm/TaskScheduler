package infrastructure

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	once sync.Once
	DB   *Database
)

type Database struct {
	Conn *pgxpool.Pool
}

func OpenDatabaseConn() {
	once.Do(func() {
		DB = new(Database)
	})
	var err error
	DB.Conn, err = pgxpool.New(context.Background(), os.Getenv("POSTGRES_DSN"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Unable to create connection pool: %v\n", err)
		os.Exit(1)
	}
}

func CloseDatabaseConn() {
	DB.Conn.Close()
}

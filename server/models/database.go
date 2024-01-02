package models

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	DB *pgxpool.Pool
)

func OpenDatabaseConnection() {
	var err error
	DB, err = pgxpool.New(context.Background(), os.Getenv("POSTGRES_DSN"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Unable to create connection pool: %v\n", err)
		os.Exit(1)
	}
}

func CloseDatabaseConnection() {
	DB.Close()
}

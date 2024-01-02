package models

import (
	"context"
	"fmt"
	"os"
)

type User struct {
	//Id        string
	Email     string
	Firstname string
	Lastname  string
	//Hash      string
}

func QueryUser() User {

	var email string
	var firstname string
	var lastname string
	err := DB.QueryRow(context.Background(), "select email, firstname, lastname from users where firstname=$1", "tester").Scan(&email, &firstname, &lastname)
	if err != nil {
		fmt.Fprintf(os.Stderr, "QueryRow failed: %v\n", err)
		os.Exit(1)
	}

	return User{
		email,
		firstname,
		lastname,
	}
}

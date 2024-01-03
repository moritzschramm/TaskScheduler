package models

import (
	"github.com/alexedwards/argon2id"
)

type Credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type RegisterEmailRequest struct {
	Email string `json:"email"`
}
type RegisterUserRequest struct {
	Firstname string `json:"firstname"`
	Lastname  string `json:"lastname"`
	Password  string `json:"password"`
}
type VerificationCodeRequest struct {
	Code string `json:"code"`
}

type User struct {
	Id        string
	Email     string
	Firstname string
	Lastname  string
	Hash      string
}

func StoreUser(userData *RegisterUserRequest) User {

	hash, err := argon2id.CreateHash(userData.Password, argon2id.DefaultParams)
	if err != nil {
		panic(err)
	}

	id := "1"

	// TODO db stuff

	return User{
		id, "", userData.Firstname, userData.Lastname, hash,
	}
}

func CheckLogin(credentials *Credentials) bool {

	// TODO get hash from email

	hash := "$argon2id$v=19$m=65536,t=1,p=8$cqlY0j49t2vjCN+gyeAY5Q$ACqRjZLFgM99b5Z6HG750lzjgQl3RYUCZjSENgMHXhg"

	match, err := argon2id.ComparePasswordAndHash(credentials.Password, hash)
	if err != nil {
		panic(err)
	}

	return match
}

/*func QueryUser() User {

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
}*/

package repository

import (
	"time"

	"task-scheduler/domain"
	"task-scheduler/infrastructure"
)

type userRepository struct {
	db    infrastructure.Database
	store infrastructure.Store
}

func NewUserRepository(db infrastructure.Database, store infrastructure.Store) domain.UserRepository {
	return &userRepository{
		db:    db,
		store: store,
	}
}

func (ur *userRepository) StoreRegisterEmail(registerId, email, code string) error {

	// TODO use messagepack or something to (de)serialize value of stored item
	ur.store.Set(registerId, []byte(code), time.Hour)

	return nil
}

func (ur *userRepository) StoreRegisterUserData(registerId, firstname, lastname, hash string) error {

	// TODO
	_, err := ur.store.Get(registerId)
	if err != nil {
		return err
	}

	return ur.store.Set(registerId, []byte(firstname), time.Hour)
}

func (ur *userRepository) GetVerificationCode(registerId string) (string, error) {

	_, err := ur.store.Get(registerId)
	if err != nil {
		return "", err
	}

	// TODO
	return "$argon2id$v=19$m=65536,t=1,p=8$cqlY0j49t2vjCN+gyeAY5Q$ACqRjZLFgM99b5Z6HG750lzjgQl3RYUCZjSENgMHXhg", nil
}

func (ur *userRepository) GetHash(email string) (string, error) {

	var hash string

	err := ur.db.QueryRow(
		"select u.passwordhash from users as u where u.email=$1",
		email,
	).Scan(&hash)
	if err != nil {
		return "", err
	}

	return hash, nil
}

func (ur *userRepository) CreateUser(user domain.User) error {

	return ur.db.Exec(
		"insert into users (email, firstname, lastname, passwordhash) values ($1,$2, $3, $4)",
		user.Email,
		user.Firstname,
		user.Lastname,
		user.Hash,
	)
}

func (ur *userRepository) DeleteUser(id string) error {

	return ur.db.Exec(
		"delete from users where id=$1",
		id,
	)
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

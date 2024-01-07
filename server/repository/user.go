package repository

import (
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

func (ur *userRepository) StoreRegisterEmail(email string) error {

	panic("Unimplemented")
}

func (ur *userRepository) StoreRegisterUserData(tmpId, firstname, lastname, hash string) error {

	panic("Unimplemented")
}

func (ur *userRepository) GetVerificationCode(tmpId string) (string, error) {

	panic("Unimplemented")
}

func (ur *userRepository) GetHash(email string) (string, error) {

	var hash string

	err := ur.db.QueryRow(
		"select u.hash from users as u where u.email=$1",
		email,
	).Scan(&hash)
	if err != nil {
		return "", err
	}

	return hash, nil
}

func (ur *userRepository) CreateUser(user domain.User) error {

	return ur.db.Exec(
		"insert into users (email, firstname, lastname, hash) values ($1,$2, $3, $4)",
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

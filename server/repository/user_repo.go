package repository

import (
	"time"

	"task-scheduler/domain"
	"task-scheduler/infrastructure"

	"github.com/vmihailenco/msgpack/v5"
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

func (ur *userRepository) ExistsEmail(email string) (bool, error) {

	var exists bool
	err := ur.db.QueryRow("select count(*) > 0 from users as u where u.email=$1", email).Scan(&exists)
	if err != nil {
		return false, err
	}

	return exists, nil
}

func (ur *userRepository) StoreRegistrationData(registerId string, regData *domain.RegistrationData) error {

	b, err := msgpack.Marshal(regData)
	if err != nil {
		return err
	}

	return ur.store.Set(registerId, b, time.Hour)
}

func (ur *userRepository) GetRegistrationData(registerId string) (*domain.RegistrationData, error) {

	b, err := ur.store.Get(registerId)
	if err != nil {
		return nil, err
	}

	var regData domain.RegistrationData
	err = msgpack.Unmarshal(b, &regData)
	if err != nil {
		return nil, err
	}

	return &regData, nil
}

func (ur *userRepository) GetPasswordHash(email string) (string, error) {

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

func (ur *userRepository) CreateUser(user *domain.User) error {

	return ur.db.Exec(
		"insert into users (email, firstname, lastname, passwordhash) values ($1,$2, $3, $4)",
		user.Email,
		user.Firstname,
		user.Lastname,
		user.PasswordHash,
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

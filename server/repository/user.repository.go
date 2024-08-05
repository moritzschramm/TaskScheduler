package repository

import (
	"task-scheduler/infrastructure"
)

type User struct {
	Id                   string
	Email                string
	Name                 string
	PasswordHash         string
	VerificationCodeHash string
}

type UserRepository struct {
	db infrastructure.Database
}

func CreateUserRepository(db infrastructure.Database) *UserRepository {
	return &UserRepository{
		db: db,
	}
}

func (ur *UserRepository) ExistsEmail(email string) (bool, error) {

	const SQL = "select count(*) > 0 from users as u where u.email=$1"

	var exists bool
	err := ur.db.QueryRow(SQL, email).Scan(&exists)
	if err != nil {
		return false, err
	}

	return exists, nil
}

func (ur *UserRepository) GetUserByEmail(email string) (*User, error) {

	const SQL = "select u.id, u.email, u.name, u.passwordhash from users as u where u.email=$1"

	user := new(User)

	err := ur.db.QueryRow(SQL, email).Scan(
		&user.Id,
		&user.Email,
		&user.Name,
		&user.PasswordHash,
	)
	if err != nil {
		return nil, err
	}

	return user, nil
}

func (ur *UserRepository) CreateUser(user *User) error {

	const SQL = "insert into users (email, name, passwordhash) values ($1, $2, $3)"

	return ur.db.Exec(SQL,
		user.Email,
		user.Name,
		user.PasswordHash,
	)
}

func (ur *UserRepository) DeleteUser(id string) error {

	const SQL = "delete from users where id=$1"

	return ur.db.Exec(SQL, id)
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

package repository

import (
	"task-scheduler/domain"
	"task-scheduler/infrastructure"

	"github.com/gofiber/fiber/v2/middleware/session"
)

const (
	EXISTS_EMAIL_SQL      = "select count(*) > 0 from users as u where u.email=$1"
	GET_USER_BY_EMAIL_SQL = "select u.id, u.email, u.name, u.passwordhash from users as u where u.email=$1"
	INSERT_USER_SQL       = "insert into users (email, name, passwordhash) values ($1, $2, $3)"
	DELETE_USER_SQL       = "delete from users where id=$1"
)

type userRepository struct {
	db      infrastructure.Database
	session *session.Store
}

func NewUserRepository(db infrastructure.Database) domain.UserRepository {
	return &userRepository{
		db: db,
	}
}

func (ur *userRepository) ExistsEmail(email string) (bool, error) {

	var exists bool
	err := ur.db.QueryRow(EXISTS_EMAIL_SQL, email).Scan(&exists)
	if err != nil {
		return false, err
	}

	return exists, nil
}

func (ur *userRepository) GetUserByEmail(email string) (*domain.User, error) {

	user := new(domain.User)

	err := ur.db.QueryRow(GET_USER_BY_EMAIL_SQL, email).Scan(
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

func (ur *userRepository) CreateUser(user *domain.User) error {

	return ur.db.Exec(INSERT_USER_SQL,
		user.Email,
		user.Name,
		user.PasswordHash,
	)
}

func (ur *userRepository) DeleteUser(id string) error {

	return ur.db.Exec(DELETE_USER_SQL, id)
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

package repository

import (
	"task-scheduler/domain"
	"task-scheduler/infrastructure"

	"github.com/gofiber/fiber/v2/middleware/session"
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
	err := ur.db.QueryRow("select count(*) > 0 from users as u where u.email=$1", email).Scan(&exists)
	if err != nil {
		return false, err
	}

	return exists, nil
}

func (ur *userRepository) GetUserByEmail(email string) (*domain.User, error) {

	user := new(domain.User)

	err := ur.db.QueryRow(
		"select u.id, u.email, u.firstname, u.lastname, u.passwordhash from users as u where u.email=$1",
		email,
	).Scan(&user.Id, &user.Email, &user.Firstname, &user.Lastname, &user.PasswordHash)
	if err != nil {
		return nil, err
	}

	return user, nil
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

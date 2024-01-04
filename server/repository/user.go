package repository

import (
	"task-scheduler/domain"
	"task-scheduler/infrastructure"
)

type userRepository struct {
	DB *infrastructure.Database
}

func NewUserRepository(db *infrastructure.Database) domain.UserRepository {
	return &userRepository{
		DB: db,
	}
}

func (ur *userRepository) Create() {

}

func (ur *userRepository) GetHash() {

}

func (ur *userRepository) Delete() {

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

package domain

import "github.com/gofiber/fiber/v2/middleware/session"

type (
	User struct {
		Id                   string
		Email                string
		Firstname            string
		Lastname             string
		PasswordHash         string
		VerificationCodeHash string
	}

	UserService interface {
		CheckEmailExists(email string) (bool, error)

		SetRegisterEmail(email string, sess *session.Session) error
		SetRegisterUserData(firstname, lastname, password string, sess *session.Session) error
		VerifyEmailAndGetTempUser(code string, sess *session.Session) (bool, *User, error)

		CreateUser(user *User) error

		CheckCredentials(email, password string) (*User, error)
	}

	UserRepository interface {
		ExistsEmail(email string) (bool, error)
		GetUserByEmail(email string) (*User, error)
		CreateUser(user *User) error
		DeleteUser(id string) error
	}
)

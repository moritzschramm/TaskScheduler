package domain

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
		SetRegisterEmail(email string) (string, error)
		SetRegisterUserData(registerId, firstname, lastname, password string) error
		VerifyEmailAndGetTempUser(registerId, code string) (bool, *User, error)

		CreateUser(user *User) error

		CheckLogin(email, password string) (bool, error)
	}

	UserRepository interface {
		SetTempUser(key string, user *User) error // store user in object store (for 1h)
		GetTempUser(key string) (*User, error)    // get user from object store

		ExistsEmail(email string) (bool, error)
		GetPasswordHash(email string) (string, error)
		CreateUser(user *User) error
		DeleteUser(id string) error
	}
)

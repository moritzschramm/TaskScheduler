package domain

// TODO consolidate User and RegistrationData structs

type User struct {
	Id           string
	Email        string
	Firstname    string
	Lastname     string
	PasswordHash string
}

type UserService interface {
	CheckEmailExists(email string) (bool, error)
	RegisterEmail(email string) (string, error)
	RegisterUserData(registerId, firstname, lastname, password string) error
	VerifyEmailAndGetRegistrationData(registerId, code string) (bool, *RegistrationData, error)
	CreateUser(user *User) error

	CheckLogin(email, password string) (bool, error)
}

type UserRepository interface {
	StoreRegistrationData(registerId string, regData *RegistrationData) error
	GetRegistrationData(registerId string) (*RegistrationData, error)

	ExistsEmail(email string) (bool, error)
	GetPasswordHash(email string) (string, error)
	CreateUser(user *User) error
	DeleteUser(id string) error
}

type RegistrationData struct {
	Email                string
	VerificationCodeHash string
	Firstname            string
	Lastname             string
	PasswordHash         string
}

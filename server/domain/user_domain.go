package domain

type User struct {
	Id        string
	Email     string
	Firstname string
	Lastname  string
	Hash      string
}

type UserService interface {
	RegisterEmail(email string) (string, error)
	RegisterUserData(registerId, firstname, lastname, password string) error
	VerifyEmail(registerId, code string) bool
	CheckLogin(email, password string) bool
}

type UserRepository interface {
	StoreRegisterEmail(registerId, email, code string) error
	StoreRegisterUserData(registerId, firstname, lastname, hash string) error
	GetVerificationCode(registerId string) (string, error)
	GetHash(email string) (string, error)
	CreateUser(user User) error
	DeleteUser(id string) error
}

package domain

type User struct {
	Id        string
	Email     string
	Firstname string
	Lastname  string
	Hash      string
}

type UserService interface {
	RegisterEmail(email string) error
	RegisterUserData(firstname, lastname, password string) error
	VerifyEmail(code string) bool
	CheckLogin(email, password string) bool
}

type UserRepository interface {
	StoreRegisterEmail(email string) error
	StoreRegisterUserData(tmpId, firstname, lastname, hash string) error
	GetVerificationCode(tmpId string) (string, error)
	GetHash(email string) (string, error)
	CreateUser(user User) error
	DeleteUser(id string) error
}

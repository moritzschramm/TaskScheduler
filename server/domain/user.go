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
	Create()
	GetHash()
	Delete()
}

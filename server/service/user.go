package service

import (
	"fmt"
	"task-scheduler/domain"

	"github.com/alexedwards/argon2id"
)

type userService struct {
	userRepository domain.UserRepository
}

func NewUserService(ur domain.UserRepository) domain.UserService {
	return &userService{
		userRepository: ur,
	}
}

func (us *userService) RegisterEmail(email string) error {

	return nil
}

func (us *userService) RegisterUserData(firstname, lastname, password string) error {

	hash, err := argon2id.CreateHash(password, argon2id.DefaultParams)
	if err != nil {
		return err
	}

	fmt.Println(hash)

	return nil
}

func (us *userService) VerifyEmail(code string) bool {

	return true
}

func (us *userService) CheckLogin(email, password string) bool {
	// TODO save IP to block after 3 attempts -> in service

	// TODO look up hash with email
	hash := "$argon2id$v=19$m=65536,t=1,p=8$cqlY0j49t2vjCN+gyeAY5Q$ACqRjZLFgM99b5Z6HG750lzjgQl3RYUCZjSENgMHXhg"

	match, err := argon2id.ComparePasswordAndHash(password, hash)
	if err != nil {
		panic(err)
	}

	return match
}

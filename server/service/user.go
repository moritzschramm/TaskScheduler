package service

import (
	"log"
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

	us.userRepository.StoreRegisterUserData("", firstname, lastname, hash)

	return nil
}

func (us *userService) VerifyEmail(code string) bool {

	storeCodeHash, err := us.userRepository.GetVerificationCode("todo") // TODO
	if err != nil {
		log.Fatalf("Error getting code hash: %v\n", err)
		return false
	}

	match, err := argon2id.ComparePasswordAndHash(code, storeCodeHash)
	if err != nil {
		log.Fatalf("Error comparing code hash: %v\n", err)
		return false
	}

	return match
}

func (us *userService) CheckLogin(email, password string) bool {
	// TODO save IP to block after 3 attempts -> in service

	hash, err := us.userRepository.GetHash(email)
	if err != nil {
		log.Fatalf("Error getting password hash: %v\n", err)
		return false
	}

	match, err := argon2id.ComparePasswordAndHash(password, hash)
	if err != nil {
		log.Fatalf("Error comparing password hash: %v\n", err)
		return false
	}

	return match
}

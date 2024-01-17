package service

import (
	"log"
	"math/big"
	"task-scheduler/domain"

	"crypto/rand"

	"github.com/alexedwards/argon2id"
	"github.com/google/uuid"
)

type userService struct {
	userRepository domain.UserRepository
}

func NewUserService(ur domain.UserRepository) domain.UserService {
	return &userService{
		userRepository: ur,
	}
}

func (us *userService) RegisterEmail(email string) (string, error) {

	registerId := uuid.New().String()

	code, err := GenerateVerificationCode()
	if err != nil {
		return "", err
	}

	hashedCode, err := argon2id.CreateHash(code, argon2id.DefaultParams)
	if err != nil {
		return "", err
	}

	err = us.userRepository.StoreRegisterEmail(registerId, email, hashedCode)
	if err != nil {
		return "", err
	}

	return registerId, nil
}

func (us *userService) RegisterUserData(registerId, firstname, lastname, password string) error {

	hash, err := argon2id.CreateHash(password, argon2id.DefaultParams)
	if err != nil {
		return err
	}

	return us.userRepository.StoreRegisterUserData(registerId, firstname, lastname, hash)
}

func (us *userService) VerifyEmail(registerId, code string) bool {

	storedCodeHash, err := us.userRepository.GetVerificationCode(registerId)
	if err != nil {
		log.Fatalf("Error getting code hash: %v\n", err)
		return false
	}

	match, err := argon2id.ComparePasswordAndHash(code, storedCodeHash)
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

func GenerateVerificationCode() (string, error) {
	const letters = "123456789ABCDEFGHIJKLMNPQRSTUVWXYZ"
	const length = 6
	ret := make([]byte, length)
	for i := 0; i < length; i++ {
		num, err := rand.Int(rand.Reader, big.NewInt(int64(len(letters))))
		if err != nil {
			return "", err
		}
		ret[i] = letters[num.Int64()]
	}

	return string(ret), nil
}

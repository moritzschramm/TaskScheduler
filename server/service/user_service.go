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

func (us *userService) CheckEmailExists(email string) (bool, error) {

	return us.userRepository.ExistsEmail(email)
}

func (us *userService) RegisterEmail(email string) (string, error) {

	registerId := uuid.New().String()

	code, err := GenerateVerificationCode()
	if err != nil {
		return "", err
	}

	// ! TODO remove in prod
	log.Printf("Email code is %v\n", code)
	// TODO send email

	hashedCode, err := argon2id.CreateHash(code, argon2id.DefaultParams)
	if err != nil {
		return "", err
	}

	regData := &domain.RegistrationData{
		Email:                email,
		VerificationCodeHash: hashedCode,
	}

	err = us.userRepository.StoreRegistrationData(registerId, regData)
	if err != nil {
		return "", err
	}

	return registerId, nil
}

func (us *userService) RegisterUserData(registerId, firstname, lastname, password string) error {

	hashedPassword, err := argon2id.CreateHash(password, argon2id.DefaultParams)
	if err != nil {
		return err
	}

	regData, err := us.userRepository.GetRegistrationData(registerId)
	if err != nil {
		return err
	}

	regData.Firstname = firstname
	regData.Lastname = lastname
	regData.PasswordHash = hashedPassword

	return us.userRepository.StoreRegistrationData(registerId, regData)
}

func (us *userService) VerifyEmailAndGetRegistrationData(registerId, code string) (bool, *domain.RegistrationData, error) {
	// TODO save IP to block after 3 attempts -> in service

	regData, err := us.userRepository.GetRegistrationData(registerId)
	if err != nil {
		return false, nil, err
	}

	match, err := argon2id.ComparePasswordAndHash(code, regData.VerificationCodeHash)
	if err != nil {
		return false, nil, err
	}

	if !match {
		return false, nil, nil
	}

	return true, regData, nil
}

func (us *userService) CreateUser(user *domain.User) error {

	return us.userRepository.CreateUser(user)
}

func (us *userService) CheckLogin(email, password string) (bool, error) {
	// TODO save IP to block after 3 attempts -> in service

	hash, err := us.userRepository.GetPasswordHash(email)
	if err != nil {
		return false, err
	}

	match, err := argon2id.ComparePasswordAndHash(password, hash)
	if err != nil {
		return false, err
	}

	return match, nil
}

func GenerateVerificationCode() (string, error) {
	const letters = "123456789ABCDEFGHIJKLMNPQRSTUVWXYZ"
	const length = 10
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

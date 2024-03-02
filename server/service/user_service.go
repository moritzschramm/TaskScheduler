package service

import (
	"errors"
	"log"
	"math/big"
	"task-scheduler/domain"

	"crypto/rand"

	"github.com/alexedwards/argon2id"
	"github.com/gofiber/fiber/v2/middleware/session"
)

const TMP_USER_KEY = "temp_user"
const ERROR_DESERIALIZATION_OF_USER_FAILED = "failed to deserialize *User from session storage"

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

func (us *userService) SetRegisterEmail(email string, sess *session.Session) error {

	code, err := GenerateVerificationCode()
	if err != nil {
		return err
	}

	// ! TODO remove in prod
	log.Printf("Email code is %v\n", code)
	// TODO send email

	hashedCode, err := argon2id.CreateHash(code, argon2id.DefaultParams)
	if err != nil {
		return err
	}

	user := &domain.User{
		Email:                email,
		VerificationCodeHash: hashedCode,
	}

	sess.Set(TMP_USER_KEY, user)

	return nil
}

func (us *userService) SetRegisterPassword(password string, sess *session.Session) error {

	hashedPassword, err := argon2id.CreateHash(password, argon2id.DefaultParams)
	if err != nil {
		return err
	}

	user, ok := sess.Get(TMP_USER_KEY).(*domain.User)
	if !ok {
		return errors.New(ERROR_DESERIALIZATION_OF_USER_FAILED)
	}

	user.PasswordHash = hashedPassword

	sess.Set(TMP_USER_KEY, user)

	return nil
}

func (us *userService) VerifyEmailAndGetTempUser(code string, sess *session.Session) (bool, *domain.User, error) {
	// TODO save IP to block after 3 attempts -> in service

	user, ok := sess.Get(TMP_USER_KEY).(*domain.User)
	if !ok {
		return false, nil, errors.New(ERROR_DESERIALIZATION_OF_USER_FAILED)
	}

	match, err := argon2id.ComparePasswordAndHash(code, user.VerificationCodeHash)
	if err != nil {
		return false, nil, err
	}

	if !match {
		return false, nil, nil
	}

	return true, user, nil
}

func (us *userService) CreateUser(user *domain.User) error {

	return us.userRepository.CreateUser(user)
}

func (us *userService) CheckCredentials(email, password string) (*domain.User, error) {
	// TODO save IP to block after 3 attempts -> in service

	user, err := us.userRepository.GetUserByEmail(email)
	if err != nil {
		return nil, nil // no hash found
	}

	match, err := argon2id.ComparePasswordAndHash(password, user.PasswordHash)
	if err != nil {
		return nil, err
	}

	if match {
		return user, nil
	}

	return nil, nil
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

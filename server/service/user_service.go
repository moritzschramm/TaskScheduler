package service

import (
	"log"
	"math/big"
	"task-scheduler/middleware"
	"task-scheduler/repository"

	"crypto/rand"

	"github.com/alexedwards/argon2id"
	"github.com/gofiber/fiber/v2/middleware/session"
)

type UserService struct {
	userRepository *repository.UserRepository
}

func CreateUserService(ur *repository.UserRepository) *UserService {
	return &UserService{
		userRepository: ur,
	}
}

func (us *UserService) CheckEmailExists(email string) (bool, error) {

	return us.userRepository.ExistsEmail(email)
}

func (us *UserService) SetRegisterEmail(email string, session *session.Session) error {

	// email address is only valid after it has been verified with a verificationCode
	verificationCode, err := GenerateVerificationCode()
	if err != nil {
		return err
	}

	// ! TODO remove in prod
	log.Printf("Email code is %v\n", verificationCode)
	// TODO send email

	// verification code is only stored as a hash in session store
	hashedCode, err := argon2id.CreateHash(verificationCode, argon2id.DefaultParams)
	if err != nil {
		return err
	}

	user := &repository.User{
		Email:                email,
		VerificationCodeHash: hashedCode,
	}

	session.Set(middleware.TemporaryUserKey, user)

	return nil
}

func (us *UserService) SetRegisterPassword(password string, session *session.Session) error {

	// hash incoming plain-text password
	hashedPassword, err := argon2id.CreateHash(password, argon2id.DefaultParams)
	if err != nil {
		return err
	}

	user, ok := session.Get(middleware.TemporaryUserKey).(*repository.User)
	if !ok {
		return middleware.SessionKeyError
	}

	user.PasswordHash = hashedPassword

	session.Set(middleware.TemporaryUserKey, user)

	return nil
}

func (us *UserService) VerifyEmailAndGetTempUser(verificationCode string, session *session.Session) (bool, *repository.User, error) {
	// TODO save IP to block after 3 attempts

	user, ok := session.Get(middleware.TemporaryUserKey).(*repository.User)
	if !ok {
		return false, nil, middleware.SessionKeyError
	}

	match, err := argon2id.ComparePasswordAndHash(verificationCode, user.VerificationCodeHash)
	if err != nil {
		return false, nil, err
	}

	if !match {
		return false, nil, nil
	}

	return true, user, nil
}

func (us *UserService) CreateUser(user *repository.User) error {

	return us.userRepository.CreateUser(user)
}

func (us *UserService) CheckCredentials(email, password string) (*repository.User, error) {
	// TODO save IP to block after 3 attempts

	user, err := us.userRepository.GetUserByEmail(email)
	if err != nil {
		return nil, nil // no user found
	}

	match, err := argon2id.ComparePasswordAndHash(password, user.PasswordHash)
	if err != nil {
		return nil, err // error while comparing password and hash
	}

	if match {
		return user, nil // success
	}

	return nil, nil // password and hash do not match
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

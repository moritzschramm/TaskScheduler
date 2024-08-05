package infrastructure

import "log"

func SendMail(msg string) {
	go func() {
		log.Printf("Sending mail with content %v", msg)
	}()
}

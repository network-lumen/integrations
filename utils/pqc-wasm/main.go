package main

import (
	"fmt"
	"syscall/js"

	dil "github.com/cloudflare/circl/sign/dilithium/mode3"
)

func main() {
	js.Global().Set("lumen_dilithium_keygen", js.FuncOf(keygen))
	js.Global().Set("lumen_dilithium_pub_from_priv", js.FuncOf(pubFromPriv))
	js.Global().Set("lumen_dilithium_sign", js.FuncOf(sign))
	select {}
}

func keygen(this js.Value, args []js.Value) any {
	pk, sk, err := dil.GenerateKey(nil)
	if err != nil {
		panic(err)
	}
	var pkBuf [dil.PublicKeySize]byte
	var skBuf [dil.PrivateKeySize]byte
	pk.Pack(&pkBuf)
	sk.Pack(&skBuf)
	return map[string]any{
		"publicKey":  bytesToJS(pkBuf[:]),
		"privateKey": bytesToJS(skBuf[:]),
	}
}

func pubFromPriv(this js.Value, args []js.Value) any {
	if len(args) != 1 {
		panic("pub_from_priv expects 1 argument")
	}
	priv := bytesFromJS(args[0])
	if len(priv) != dil.PrivateKeySize {
		panic(fmt.Sprintf("invalid private key length: %d", len(priv)))
	}
	var buf [dil.PrivateKeySize]byte
	copy(buf[:], priv)
	var sk dil.PrivateKey
	sk.Unpack(&buf)
	pk := sk.Public().(*dil.PublicKey)
	var pkBuf [dil.PublicKeySize]byte
	pk.Pack(&pkBuf)
	return bytesToJS(pkBuf[:])
}

func sign(this js.Value, args []js.Value) any {
	if len(args) != 2 {
		panic("sign expects privateKey, message")
	}
	priv := bytesFromJS(args[0])
	msg := bytesFromJS(args[1])

	if len(priv) != dil.PrivateKeySize {
		panic(fmt.Sprintf("invalid private key length: %d", len(priv)))
	}

	var buf [dil.PrivateKeySize]byte
	copy(buf[:], priv)

	var sk dil.PrivateKey
	sk.Unpack(&buf)

	sig := make([]byte, dil.SignatureSize)
	dil.SignTo(&sk, msg, sig)
	return bytesToJS(sig)
}

func bytesFromJS(value js.Value) []byte {
	length := value.Length()
	buf := make([]byte, length)
	js.CopyBytesToGo(buf, value)
	return buf
}

func bytesToJS(data []byte) js.Value {
	array := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(array, data)
	return array
}

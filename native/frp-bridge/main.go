package main
/*
#include <stdlib.h>
*/
import "C"
import (
 "context"
 "sync"
 "unsafe"
 "github.com/fatedier/frp/client"
 "github.com/fatedier/frp/pkg/config"
 "github.com/fatedier/frp/pkg/config/source"
 v1 "github.com/fatedier/frp/pkg/config/v1"
)
var mu sync.Mutex
var service *client.Service
var state = "stopped"
//export StartTunnel
func StartTunnel(raw *C.char) C.int {
 if raw==nil{return -1}
 mu.Lock();defer mu.Unlock()
 if service!=nil{return -2}
 var parsed v1.ClientConfig
 if err:=config.LoadConfigure([]byte(C.GoString(raw)),&parsed,true,"toml");err!=nil{return -3}
 if err:=parsed.ClientCommonConfig.Complete();err!=nil{return -4}
 cs:=source.NewConfigSource()
 proxies:=make([]v1.ProxyConfigurer,0,len(parsed.Proxies))
 for _,p:=range parsed.Proxies {proxies=append(proxies,p.ProxyConfigurer)}
 visitors:=make([]v1.VisitorConfigurer,0,len(parsed.Visitors))
 for _,v:=range parsed.Visitors {visitors=append(visitors,v.VisitorConfigurer)}
 if err:=cs.ReplaceAll(proxies,visitors);err!=nil{return -5}
 svr,err:=client.NewService(client.ServiceOptions{Common:&parsed.ClientCommonConfig,ConfigSourceAggregator:source.NewAggregator(cs)})
 if err!=nil{return -6}
 service=svr;state="running"
 go func(){_ =svr.Run(context.Background());mu.Lock();if service==svr {service=nil;state="stopped"};mu.Unlock()}()
 return 0
}
//export StopTunnel
func StopTunnel() C.int {mu.Lock();defer mu.Unlock();if service==nil{return 0};service.Close();state="stopping";return 0}
//export TunnelStatus
func TunnelStatus() *C.char {mu.Lock();defer mu.Unlock();return C.CString(state)}
//export FreeTunnelString
func FreeTunnelString(s *C.char){C.free(unsafe.Pointer(s))}
func main(){}

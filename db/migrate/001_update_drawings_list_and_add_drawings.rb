drawings = REDIS.lrange("drawings", 0, -1).map {|o| JSON.parse(o)}

REDIS.keys("drawing*").each {|k| REDIS.del k}

drawings.each do |d|
  d_id = d.delete('id')
  REDIS.set "drawing:#{d_id}", d.to_json
  REDIS.rpush "drawings", d_id
end
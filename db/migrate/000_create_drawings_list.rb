init_aws

drawings = AWS::S3::Bucket.objects(S3_BUCKET).sort {|a, b| b.key <=> a.key}

drawing_objs = drawings.map {|e| {:id => e.key, :url => e.url(:authenticated => false)}}

drawing_objs.each do |o|
  REDIS.rpush "drawings", o.to_json
end
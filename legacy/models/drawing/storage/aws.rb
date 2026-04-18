module Storage
  module Aws
    def self.included(base) # :nodoc:
      base.extend ClassMethods
    end
  
    module ClassMethods
      # init_aws
      def init_aws
        ::AWS::S3::Base.establish_connection!(
          :access_key_id     => ENV['S3_KEY'],
          :secret_access_key => ENV['S3_SECRET']
        )
      end
      
      # save_file
      def save_file(filename, request_host, content)
        init_aws
        # save file
        ::AWS::S3::S3Object.store(filename, content, S3_BUCKET, :access => :public_read)
        # return object public url
        ::AWS::S3::S3Object.find(filename, S3_BUCKET).url(:authenticated => false)
      end
      
      # delete_file
      def delete_file(filename)
        init_aws
        # delete object
        ::AWS::S3::S3Object.delete(filename, S3_BUCKET)
      end
    end
  end
end